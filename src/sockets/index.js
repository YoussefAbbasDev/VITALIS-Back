import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { query, queryOne } from '../db/pool.js';
import { socketUserFromCookie } from '../middleware/auth.js';
import { mapAlert, redactAlert } from '../services/alerts.js';

/**
 * Real-time layer:
 *  - polls MySQL every 2s for rows with a higher id
 *  - polls alert state + readiness state for changes (no updated_at on alerts)
 *  - emits new/updated events into role-scoped rooms:
 *      astronaut:{id} -> the astronaut + their medical officer
 *      cabin          -> all astronauts + all medical officers
 *      admin          -> readiness changes and device/environment alerts only
 */
const POLL_MS = 2000;

function mapReading(row, lastTrusted) {
  return {
    id: Number(row.id),
    astronautId: Number(row.astronaut_id),
    metric: row.metric,
    value: Number(row.value),
    unit: row.unit,
    ts: row.ts,
    confidence: Number(row.confidence),
    trustStatus: row.trust_status,
    trustReason: row.trust_reason ?? null,
    sourceDevice: row.source_device,
    lastTrusted: lastTrusted ?? null,
  };
}

function mapEnvironment(row, lastTrusted) {
  return {
    id: Number(row.id),
    metric: row.metric,
    value: Number(row.value),
    unit: row.unit,
    ts: row.ts,
    confidence: Number(row.confidence),
    trustStatus: row.trust_status,
    trustReason: row.trust_reason ?? null,
    source: row.source,
    lastTrusted: lastTrusted ?? null,
  };
}

function mapRadiation(row, lastTrusted) {
  return {
    id: Number(row.id),
    astronautId: Number(row.astronaut_id),
    ts: row.ts,
    rateUsvPerHour: Number(row.rate_usv_per_h),
    cumulativeMsv: Number(row.cumulative_msv),
    confidence: Number(row.confidence),
    trustStatus: row.trust_status,
    trustReason: row.trust_reason ?? null,
    lastTrusted: lastTrusted ?? null,
  };
}

function mapFault(row) {
  return {
    id: Number(row.id),
    astronautId: row.astronaut_id ? Number(row.astronaut_id) : null,
    device: row.device,
    metric: row.metric,
    faultType: row.fault_type,
    details: row.details,
    detectedAt: row.detected_at,
    scope: row.astronaut_id ? 'astronaut' : 'cabin',
  };
}

function alertStateKey(row) {
  return `${row.acknowledged_at ?? ''}|${row.resolved_at ?? ''}|${row.escalated_at ?? ''}`;
}

async function attachReadingTrust(row) {
  if (row.trust_status === 'trusted') {
    return { value: Number(row.value), ts: row.ts };
  }
  const previous = await queryOne(
    `SELECT value, ts FROM readings
     WHERE astronaut_id = ? AND metric = ? AND trust_status = 'trusted' AND ts < ?
     ORDER BY ts DESC, id DESC LIMIT 1`,
    [row.astronaut_id, row.metric, row.ts],
  );
  return previous ? { value: Number(previous.value), ts: previous.ts } : null;
}

export function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.CLIENT_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const user = await socketUserFromCookie(socket.handshake.headers.cookie);
      if (!user) return next(new Error('unauthorized'));
      socket.user = { id: Number(user.id), role: user.role, name: user.name };
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.user;
    if (user.role === 'admin') {
      // Admin never joins cabin: no medical rows, no full alerts.
      socket.join('admin');
    } else if (user.role === 'medical') {
      socket.join('cabin');
      const assigned = await query(
        'SELECT astronaut_id FROM assignments WHERE medical_officer_id = ?',
        [user.id],
      );
      for (const row of assigned) socket.join(`astronaut:${row.astronaut_id}`);
    } else if (user.role === 'astronaut') {
      socket.join('cabin');
      socket.join(`astronaut:${user.id}`);
    }
    socket.emit('socket:ready', { userId: user.id, role: user.role });
  });

  // Track ids / state. Using MAX(id) at startup avoids replaying history.
  const ids = {};
  let alertState = new Map();
  let readinessState = new Map();
  let stopped = false;

  async function bootstrap() {
    const [readings, envRows, radRows, alerts, faults, readiness] = await Promise.all([
      queryOne('SELECT COALESCE(MAX(id), 0) AS maxId FROM readings'),
      queryOne('SELECT COALESCE(MAX(id), 0) AS maxId FROM environment_readings'),
      queryOne('SELECT COALESCE(MAX(id), 0) AS maxId FROM radiation_readings'),
      queryOne('SELECT COALESCE(MAX(id), 0) AS maxId FROM alerts'),
      queryOne('SELECT COALESCE(MAX(id), 0) AS maxId FROM sensor_faults'),
      query('SELECT astronaut_id, status, updated_at FROM readiness'),
    ]);
    ids.readings = Number(readings.maxId);
    ids.env = Number(envRows.maxId);
    ids.radiation = Number(radRows.maxId);
    ids.alerts = Number(alerts.maxId);
    ids.faults = Number(faults.maxId);

    const activeAlerts = await query(
      `SELECT id, acknowledged_at, resolved_at, escalated_at FROM alerts
       WHERE resolved_at IS NULL OR resolved_at >= DATE_SUB(NOW(3), INTERVAL 1 HOUR)`,
    );
    alertState = new Map(activeAlerts.map((a) => [Number(a.id), alertStateKey(a)]));
    readinessState = new Map(
      readiness.map((r) => [Number(r.astronaut_id), `${r.status}|${r.updated_at}`]),
    );
  }

  async function emitNewReadings() {
    const rows = await query(
      'SELECT * FROM readings WHERE id > ? ORDER BY id ASC LIMIT 300',
      [ids.readings],
    );
    for (const row of rows) {
      const payload = mapReading(row, await attachReadingTrust(row));
      io.to(`astronaut:${row.astronaut_id}`).emit('reading:new', payload);
      ids.readings = Math.max(ids.readings, Number(row.id));
    }
  }

  async function emitNewEnvironment() {
    const rows = await query(
      'SELECT * FROM environment_readings WHERE id > ? ORDER BY id ASC LIMIT 200',
      [ids.env],
    );
    for (const row of rows) {
      let lastTrusted = null;
      if (row.trust_status === 'trusted') {
        lastTrusted = { value: Number(row.value), ts: row.ts };
      } else {
        const prev = await queryOne(
          `SELECT value, ts FROM environment_readings
           WHERE metric = ? AND trust_status = 'trusted' AND ts < ?
           ORDER BY ts DESC, id DESC LIMIT 1`,
          [row.metric, row.ts],
        );
        if (prev) lastTrusted = { value: Number(prev.value), ts: prev.ts };
      }
      io.to('cabin').emit('env:new', mapEnvironment(row, lastTrusted));
      ids.env = Math.max(ids.env, Number(row.id));
    }
  }

  async function emitNewRadiation() {
    const rows = await query(
      'SELECT * FROM radiation_readings WHERE id > ? ORDER BY id ASC LIMIT 200',
      [ids.radiation],
    );
    for (const row of rows) {
      let lastTrusted = null;
      if (row.trust_status === 'trusted') {
        lastTrusted = { value: Number(row.cumulative_msv), ts: row.ts };
      } else {
        const prev = await queryOne(
          `SELECT cumulative_msv, ts FROM radiation_readings
           WHERE astronaut_id = ? AND trust_status = 'trusted' AND ts < ?
           ORDER BY ts DESC, id DESC LIMIT 1`,
          [row.astronaut_id, row.ts],
        );
        if (prev) lastTrusted = { value: Number(prev.cumulative_msv), ts: prev.ts };
      }
      io.to(`astronaut:${row.astronaut_id}`).emit('radiation:new', mapRadiation(row, lastTrusted));
      ids.radiation = Math.max(ids.radiation, Number(row.id));
    }
  }

  async function emitNewFaults() {
    const rows = await query(
      'SELECT * FROM sensor_faults WHERE id > ? ORDER BY id ASC LIMIT 100',
      [ids.faults],
    );
    for (const row of rows) {
      const payload = mapFault(row);
      if (row.astronaut_id) {
        io.to(`astronaut:${row.astronaut_id}`).emit('fault:new', payload);
      } else {
        io.to('cabin').emit('fault:new', payload);
      }
      io.to('admin').emit('fault:new', {
        id: payload.id,
        device: payload.device,
        metric: payload.metric,
        faultType: payload.faultType,
        detectedAt: payload.detectedAt,
        scope: payload.scope,
      });
      ids.faults = Math.max(ids.faults, Number(row.id));
    }
  }

  async function emitNewAlerts() {
    const rows = await query(
      `SELECT a.*, u.name AS astronaut_name FROM alerts a
       LEFT JOIN users u ON u.id = a.astronaut_id
       WHERE a.id > ? ORDER BY a.id ASC LIMIT 100`,
      [ids.alerts],
    );
    for (const row of rows) {
      const alert = mapAlert(row);
      if (row.astronaut_id) {
        io.to(`astronaut:${row.astronaut_id}`).emit('alert:new', alert);
      } else {
        io.to('cabin').emit('alert:new', alert);
      }
      if (alert.category === 'device' || alert.category === 'environment') {
        io.to('admin').emit('alert:new', redactAlert(alert));
      }
      alertState.set(alert.id, alertStateKey(row));
      ids.alerts = Math.max(ids.alerts, Number(row.id));
    }
  }

  async function emitAlertUpdates() {
    // Alerts have no updated_at column, so compare the action timestamps of
    // unresolved and recently resolved alerts against the in-memory snapshot.
    const rows = await query(
      `SELECT a.*, u.name AS astronaut_name FROM alerts a
       LEFT JOIN users u ON u.id = a.astronaut_id
       WHERE a.resolved_at IS NULL OR a.resolved_at >= DATE_SUB(NOW(3), INTERVAL 1 HOUR)`,
    );

    for (const row of rows) {
      const id = Number(row.id);
      const key = alertStateKey(row);
      const previous = alertState.get(id);
      if (previous === undefined || previous === key) {
        alertState.set(id, key);
        continue;
      }
      alertState.set(id, key);

      const alert = mapAlert(row);
      if (row.astronaut_id) {
        io.to(`astronaut:${row.astronaut_id}`).emit('alert:updated', alert);
      } else {
        io.to('cabin').emit('alert:updated', alert);
      }
      if (alert.category === 'device' || alert.category === 'environment') {
        io.to('admin').emit('alert:updated', redactAlert(alert));
      }
    }
  }

  async function emitReadinessChanges() {
    const rows = await query(
      'SELECT astronaut_id, status, updated_at FROM readiness',
    );
    for (const row of rows) {
      const id = Number(row.astronaut_id);
      const key = `${row.status}|${row.updated_at}`;
      if (readinessState.get(id) === key) continue;
      readinessState.set(id, key);
      const payload = {
        astronautId: id,
        status: row.status,
        updatedAt: row.updated_at,
      };
      io.to('admin').emit('readiness:updated', payload);
      io.to(`astronaut:${id}`).emit('readiness:updated', payload);
    }
  }

  async function poll() {
    if (stopped) return;
    try {
      await emitNewReadings();
      await emitNewEnvironment();
      await emitNewRadiation();
      await emitNewAlerts();
      await emitAlertUpdates();
      await emitNewFaults();
      await emitReadinessChanges();
    } catch (err) {
      console.error('[socket poll]', err.message);
    }
  }

  bootstrap()
    .then(() => {
      console.log(`Socket.IO ready (polling every ${POLL_MS / 1000}s)`);
      const timer = setInterval(poll, POLL_MS);
      httpServer.on('close', () => {
        stopped = true;
        clearInterval(timer);
      });
    })
    .catch((err) => {
      console.error('Socket bootstrap failed:', err.message);
    });

  return io;
}
