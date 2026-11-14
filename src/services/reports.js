import PDFDocument from 'pdfkit';
import { query } from '../db/pool.js';
import { getMission } from './mission.js';
import { getAstronautProfile } from './audit.js';
import {
  getBaselines,
  getLatestEnvironment,
  getLatestReadings,
  getMetricRanges,
  HEALTH_METRIC_ORDER,
  METRIC_LABELS,
} from './readings.js';
import { getRadiationSummary } from './radiation.js';
import { getAlertCounts } from './status.js';
import { parseJson } from './alerts.js';

export const REPORT_TYPES = {
  'daily-health': 'Daily health report',
  radiation: 'Radiation report',
  environment: 'Environment report',
  'data-reliability': 'Data reliability report',
};

export const REPORT_NOTE =
  'Decision support, not a medical diagnosis. Severity and risk levels come from the alerts table and the configured metric ranges. Readings marked suspect or excluded are not used for clinical trends.';

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}
function timeLabel(value) {
  if (!value) return '—';
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
function num(value, digits = 1) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return n.toFixed(digits).replace(/\.0+$/, '');
}

function statusLabel(alert) {
  if (alert.resolved_at) return 'resolved';
  if (alert.escalated_at) return 'escalated';
  if (alert.acknowledged_at) return 'acknowledged';
  return 'active';
}

function trustLabel(status) {
  return status ? status[0].toUpperCase() + status.slice(1) : '—';
}

export async function buildReport(type, { astronautId = null, from, to }) {
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T23:59:59.999Z`);
  const mission = await getMission();
  const astronaut = astronautId ? await getAstronautProfile(astronautId) : null;

  const report = {
    type,
    title: REPORT_TYPES[type],
    generatedAt: new Date().toISOString(),
    period: { from, to, days: Math.round((toDate - fromDate) / DAY_MS) },
    mission: mission
      ? { name: mission.name, day: mission.day, totalDays: mission.totalDays }
      : null,
    astronaut,
    summary: [],
    tables: [],
    notes: [],
    note: REPORT_NOTE,
    layout: 'portrait',
  };

  if (type === 'daily-health') {
    const [aggregates, latest, baselines, ranges, alertCounts, alerts, checkins, sleep, notes] =
      await Promise.all([
        query(
          `SELECT metric, unit, COUNT(*) AS total,
                  SUM(CASE WHEN trust_status = 'trusted' THEN 1 ELSE 0 END) AS trusted,
                  SUM(CASE WHEN trust_status = 'suspect' THEN 1 ELSE 0 END) AS suspect,
                  SUM(CASE WHEN trust_status = 'excluded' THEN 1 ELSE 0 END) AS excluded,
                  AVG(CASE WHEN trust_status = 'trusted' THEN value END) AS avg_value,
                  MIN(CASE WHEN trust_status = 'trusted' THEN value END) AS min_value,
                  MAX(CASE WHEN trust_status = 'trusted' THEN value END) AS max_value
           FROM readings
           WHERE astronaut_id = ? AND ts BETWEEN ? AND ?
           GROUP BY metric, unit`,
          [astronautId, fromDate, toDate],
        ),
        getLatestReadings(astronautId),
        getBaselines(astronautId),
        getMetricRanges('health'),
        getAlertCounts(astronautId),
        query(
          `SELECT a.*, u.name AS astronaut_name FROM alerts a
           LEFT JOIN users u ON u.id = a.astronaut_id
           WHERE (a.astronaut_id = ? OR a.astronaut_id IS NULL)
             AND a.created_at BETWEEN ? AND ?
           ORDER BY a.created_at DESC`,
          [astronautId, fromDate, toDate],
        ),
        query(
          `SELECT c.*, COALESCE(SUM(e.duration_min), 0) AS exercise_min
           FROM checkins c LEFT JOIN exercise_logs e ON e.checkin_id = c.id
           WHERE c.astronaut_id = ? AND c.date BETWEEN ? AND ?
           GROUP BY c.id ORDER BY c.date ASC`,
          [astronautId, from, to],
        ),
        query(
          `SELECT * FROM sleep_records WHERE astronaut_id = ? AND date BETWEEN ? AND ?
           ORDER BY date ASC`,
          [astronautId, from, to],
        ),
        query(
          `SELECT n.*, u.name AS author_name FROM medical_notes n
           JOIN users u ON u.id = n.author_id
           WHERE n.astronaut_id = ? AND n.created_at BETWEEN ? AND ?
           ORDER BY n.created_at DESC`,
          [astronautId, fromDate, toDate],
        ),
      ]);

    const latestByMetric = Object.fromEntries(latest.map((r) => [r.metric, r]));
    const avgSleep = sleep.length
      ? sleep.reduce((sum, s) => sum + Number(s.duration_min), 0) / sleep.length
      : null;

    report.summary = [
      { label: 'Readiness', value: trustLabel(astronaut?.readiness) },
      { label: 'Active alerts', value: `${alertCounts.critical} critical / ${alertCounts.warning} warning` },
      { label: 'Heart rate (latest)', value: latestByMetric.heart_rate ? `${num(latestByMetric.heart_rate.value, 0)} bpm` : '—' },
      { label: 'SpO2 (latest)', value: latestByMetric.spo2 ? `${num(latestByMetric.spo2.value, 0)} %` : '—' },
      { label: 'Check-ins in period', value: String(checkins.length) },
      { label: 'Average sleep', value: avgSleep === null ? '—' : `${num(avgSleep / 60, 1)} h` },
    ];

    report.tables.push({
      title: 'Vitals (trusted readings only for statistics)',
      columns: ['Metric', 'Latest', 'Baseline', 'Average', 'Min', 'Max', 'T/S/E', 'Unit'],
      rows: HEALTH_METRIC_ORDER.map((metric) => {
        const agg = aggregates.find((a) => a.metric === metric);
        const last = latestByMetric[metric];
        const base = baselines[metric];
        return [
          METRIC_LABELS[metric],
          last ? num(last.value, 1) : '—',
          base ? `${num(base.mean, 1)} ± ${num(base.std, 1)}` : '—',
          agg ? num(agg.avg_value, 1) : '—',
          agg ? num(agg.min_value, 1) : '—',
          agg ? num(agg.max_value, 1) : '—',
          agg ? `${agg.trusted}/${agg.suspect}/${agg.excluded}` : '—',
          ranges[metric]?.unit ?? agg?.unit ?? '',
        ];
      }),
    });

    report.tables.push({
      title: 'Alerts in period',
      columns: ['Time', 'Category', 'Severity', 'Title', 'Basis', 'Status'],
      rows: alerts.map((a) => [
        timeLabel(a.created_at),
        a.category,
        a.severity,
        a.title,
        a.basis_text ?? '—',
        statusLabel(a),
      ]),
      empty: 'No alerts in this period.',
    });

    report.tables.push({
      title: 'Wellness in period',
      columns: ['Date', 'Sleep (h)', 'Quality', 'Stress', 'Mood', 'Focus', 'Fatigue', 'Exercise (min)'],
      rows: checkins.map((c) => {
        const sleepRow = sleep.find((s) => String(s.date).slice(0, 10) === String(c.date).slice(0, 10));
        return [
          String(c.date).slice(0, 10),
          sleepRow ? num(Number(sleepRow.duration_min) / 60, 1) : '—',
          sleepRow ? String(sleepRow.quality_score) : '—',
          String(c.stress),
          String(c.mood),
          String(c.focus),
          String(c.fatigue),
          String(c.exercise_min),
        ];
      }),
      empty: 'No check-ins in this period.',
    });

    report.tables.push({
      title: 'Notes and instructions',
      columns: ['Time', 'Kind', 'Author', 'Marked read', 'Body'],
      rows: notes.map((n) => [
        timeLabel(n.created_at),
        n.kind,
        n.author_name,
        n.read_at ? timeLabel(n.read_at) : 'unread',
        n.body,
      ]),
      empty: 'No notes in this period.',
    });

    report.notes.push(
      'Vitals statistics use trusted readings only. Suspect and excluded rows are counted in the T/S/E column for transparency.',
    );
    report.layout = 'landscape';
  }

  if (type === 'radiation') {
    const [aggregate, daily, alerts, projection] = await Promise.all([
      query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN trust_status = 'trusted' THEN 1 ELSE 0 END) AS trusted,
                AVG(CASE WHEN trust_status = 'trusted' THEN rate_usv_per_h END) AS avg_rate,
                MAX(CASE WHEN trust_status = 'trusted' THEN rate_usv_per_h END) AS max_rate,
                MIN(CASE WHEN trust_status = 'trusted' THEN cumulative_msv END) AS min_cumulative,
                MAX(CASE WHEN trust_status = 'trusted' THEN cumulative_msv END) AS max_cumulative
         FROM radiation_readings
         WHERE astronaut_id = ? AND ts BETWEEN ? AND ?`,
        [astronautId, fromDate, toDate],
      ),
      query(
        `SELECT DATE(ts) AS date,
                AVG(CASE WHEN trust_status = 'trusted' THEN rate_usv_per_h END) AS avg_rate,
                MAX(CASE WHEN trust_status = 'trusted' THEN cumulative_msv END) AS cumulative
         FROM radiation_readings
         WHERE astronaut_id = ? AND ts BETWEEN ? AND ?
         GROUP BY DATE(ts) ORDER BY date ASC`,
        [astronautId, fromDate, toDate],
      ),
      query(
        `SELECT * FROM alerts
         WHERE astronaut_id = ? AND category = 'radiation' AND created_at BETWEEN ? AND ?
         ORDER BY created_at DESC`,
        [astronautId, fromDate, toDate],
      ),
      getRadiationSummary(astronautId, '7d'),
    ]);

    const agg = aggregate[0];
    report.summary = [
      { label: 'Current rate', value: projection.currentRate === null ? '—' : `${num(projection.currentRate, 1)} µSv/h` },
      { label: 'Cumulative dose', value: `${num(projection.cumulativeMsv, 2)} mSv` },
      { label: "Dose today", value: `${num(projection.todayDoseMsv, 3)} mSv` },
      { label: 'Average per day (7d)', value: `${num(projection.averageDailyDoseLast7d, 3)} mSv` },
      { label: 'Projected total', value: `${num(projection.projectedTotal, 1)} mSv` },
      { label: 'Mission limit', value: projection.limit === null ? '—' : `${num(projection.limit, 1)} mSv` },
      { label: 'Projected % of limit', value: projection.percentOfLimit === null ? '—' : `${num(projection.percentOfLimit, 1)} %` },
      { label: 'Status', value: projection.exceedsLimit ? 'Exceeds limit' : 'On track' },
    ];

    report.tables.push({
      title: 'Daily dosimetry in period',
      columns: ['Date', 'Average rate (µSv/h)', 'Cumulative (mSv)'],
      rows: daily.map((d) => [
        String(d.date).slice(0, 10),
        num(d.avg_rate, 1),
        num(d.cumulative, 2),
      ]),
      empty: 'No radiation readings in this period.',
    });

    report.tables.push({
      title: 'Period statistics',
      columns: ['Metric', 'Value'],
      rows: [
        ['Readings', String(agg.total ?? 0)],
        ['Trusted readings', String(agg.trusted ?? 0)],
        ['Average rate (µSv/h)', num(agg.avg_rate, 2)],
        ['Maximum rate (µSv/h)', num(agg.max_rate, 2)],
        ['Cumulative at start (mSv)', num(agg.min_cumulative, 2)],
        ['Cumulative at end (mSv)', num(agg.max_cumulative, 2)],
        ['Remaining mission days', String(projection.remainingDays)],
      ],
    });

    report.tables.push({
      title: 'Radiation alerts in period',
      columns: ['Time', 'Severity', 'Title', 'Basis', 'Status'],
      rows: alerts.map((a) => [
        timeLabel(a.created_at),
        a.severity,
        a.title,
        a.basis_text ?? '—',
        statusLabel(a),
      ]),
      empty: 'No radiation alerts in this period.',
    });

    report.notes.push(
      'The projection extends the average daily dose of the last 7 days to the remaining mission days and compares it with the configured mission limit. It is an estimate, not a forecast.',
    );
  }

  if (type === 'environment') {
    const [aggregates, latest, ranges, alerts] = await Promise.all([
      query(
        `SELECT metric, unit, COUNT(*) AS total,
                AVG(CASE WHEN trust_status = 'trusted' THEN value END) AS avg_value,
                MIN(CASE WHEN trust_status = 'trusted' THEN value END) AS min_value,
                MAX(CASE WHEN trust_status = 'trusted' THEN value END) AS max_value,
                SUM(CASE WHEN trust_status = 'trusted' THEN 1 ELSE 0 END) AS trusted,
                SUM(CASE WHEN trust_status = 'suspect' THEN 1 ELSE 0 END) AS suspect,
                SUM(CASE WHEN trust_status = 'excluded' THEN 1 ELSE 0 END) AS excluded
         FROM environment_readings
         WHERE ts BETWEEN ? AND ?
         GROUP BY metric, unit`,
        [fromDate, toDate],
      ),
      getLatestEnvironment(),
      getMetricRanges('environment'),
      query(
        `SELECT * FROM alerts
         WHERE category = 'environment' AND (astronaut_id IS NULL OR astronaut_id = ?)
           AND created_at BETWEEN ? AND ?
         ORDER BY created_at DESC`,
        [astronautId, fromDate, toDate],
      ),
    ]);

    const latestByMetric = Object.fromEntries(latest.map((m) => [m.metric, m]));
    const activeEnv = alerts.filter((a) => !a.resolved_at);

    report.summary = [
      { label: 'O2', value: latestByMetric.o2?.value != null ? `${num(latestByMetric.o2.value, 2)} %` : '—' },
      { label: 'CO2', value: latestByMetric.co2?.value != null ? `${num(latestByMetric.co2.value, 0)} ppm` : '—' },
      { label: 'Pressure', value: latestByMetric.pressure?.value != null ? `${num(latestByMetric.pressure.value, 2)} kPa` : '—' },
      { label: 'Temperature', value: latestByMetric.temperature?.value != null ? `${num(latestByMetric.temperature.value, 1)} °C` : '—' },
      { label: 'Humidity', value: latestByMetric.humidity?.value != null ? `${num(latestByMetric.humidity.value, 1)} %` : '—' },
      { label: 'Air quality', value: latestByMetric.air_quality?.value != null ? `${num(latestByMetric.air_quality.value, 0)} AQI` : '—' },
      { label: 'Environment alerts', value: `${activeEnv.length} active in period` },
    ];

    report.tables.push({
      title: 'Environment statistics',
      columns: ['Metric', 'Latest', 'Average', 'Min', 'Max', 'Safe range', 'T/S/E', 'Unit'],
      rows: ['o2', 'co2', 'pressure', 'temperature', 'humidity', 'air_quality'].map((metric) => {
        const agg = aggregates.find((a) => a.metric === metric);
        const range = ranges[metric];
        const current = latestByMetric[metric];
        return [
          METRIC_LABELS[metric],
          current?.value != null ? num(current.value, 2) : '—',
          agg ? num(agg.avg_value, 2) : '—',
          agg ? num(agg.min_value, 2) : '—',
          agg ? num(agg.max_value, 2) : '—',
          range ? `${num(range.safeMin, 1)} – ${num(range.safeMax, 1)}` : '—',
          agg ? `${agg.trusted}/${agg.suspect}/${agg.excluded}` : '—',
          range?.unit ?? agg?.unit ?? '',
        ];
      }),
      empty: 'No environment readings in this period.',
    });

    report.tables.push({
      title: 'Environment alerts in period',
      columns: ['Time', 'Severity', 'Title', 'Basis', 'Status'],
      rows: alerts.map((a) => [
        timeLabel(a.created_at),
        a.severity,
        a.title,
        a.basis_text ?? '—',
        statusLabel(a),
      ]),
      empty: 'No environment alerts in this period.',
    });

    report.notes.push('Cabin environment values are monitored, not controlled, by VITALIS.');
    report.layout = 'landscape';
  }

  if (type === 'data-reliability') {
    const [trustRows, bucketRows, reasonRows, faults, totalRow] = await Promise.all([
      query(
        `SELECT trust_status, COUNT(*) AS count FROM readings
         WHERE astronaut_id = ? AND ts BETWEEN ? AND ? GROUP BY trust_status`,
        [astronautId, fromDate, toDate],
      ),
      query(
        `SELECT LEAST(FLOOR(confidence * 5), 4) AS bucket, COUNT(*) AS count
         FROM readings WHERE astronaut_id = ? AND ts BETWEEN ? AND ? GROUP BY bucket`,
        [astronautId, fromDate, toDate],
      ),
      query(
        `SELECT trust_reason, COUNT(*) AS count FROM readings
         WHERE astronaut_id = ? AND trust_status <> 'trusted' AND ts BETWEEN ? AND ?
         GROUP BY trust_reason ORDER BY count DESC LIMIT 10`,
        [astronautId, fromDate, toDate],
      ),
      query(
        `SELECT * FROM sensor_faults
         WHERE (astronaut_id = ? OR astronaut_id IS NULL) AND detected_at BETWEEN ? AND ?
         ORDER BY detected_at DESC`,
        [astronautId, fromDate, toDate],
      ),
      query(
        `SELECT COUNT(*) AS total,
                AVG(CASE WHEN trust_status = 'trusted' THEN confidence END) AS avg_confidence
         FROM readings WHERE astronaut_id = ? AND ts BETWEEN ? AND ?`,
        [astronautId, fromDate, toDate],
      ),
    ]);

    const trust = { trusted: 0, suspect: 0, excluded: 0 };
    for (const row of trustRows) trust[row.trust_status] = Number(row.count);
    const total = trust.trusted + trust.suspect + trust.excluded;
    const confidenceBuckets = ['0.0–0.2', '0.2–0.4', '0.4–0.6', '0.6–0.8', '0.8–1.0'].map(
      (label, index) => ({
        label,
        count: Number(bucketRows.find((b) => Number(b.bucket) === index)?.count ?? 0),
      }),
    );

    report.summary = [
      { label: 'Readings in period', value: String(total) },
      { label: 'Trusted', value: total ? `${num((trust.trusted / total) * 100, 1)} %` : '—' },
      { label: 'Suspect', value: total ? `${num((trust.suspect / total) * 100, 1)} %` : '—' },
      { label: 'Excluded', value: total ? `${num((trust.excluded / total) * 100, 1)} %` : '—' },
      { label: 'Average confidence', value: num(totalRow[0]?.avg_confidence, 2) },
      { label: 'Sensor faults', value: String(faults.length) },
      { label: 'Fault types', value: String(new Set(faults.map((f) => f.fault_type)).size) },
    ];

    report.tables.push({
      title: 'Trust distribution',
      columns: ['Trust state', 'Readings', 'Share'],
      rows: [
        ['Trusted', String(trust.trusted), total ? `${num((trust.trusted / total) * 100, 1)} %` : '—'],
        ['Suspect', String(trust.suspect), total ? `${num((trust.suspect / total) * 100, 1)} %` : '—'],
        ['Excluded', String(trust.excluded), total ? `${num((trust.excluded / total) * 100, 1)} %` : '—'],
      ],
    });

    report.tables.push({
      title: 'Confidence distribution',
      columns: ['Confidence bucket', 'Readings'],
      rows: confidenceBuckets.map((b) => [b.label, String(b.count)]),
    });

    report.tables.push({
      title: 'Top trust reasons',
      columns: ['Reason', 'Readings'],
      rows: reasonRows.map((r) => [r.trust_reason ?? 'Unspecified', String(r.count)]),
      empty: 'No suspect or excluded readings in this period.',
    });

    report.tables.push({
      title: 'Sensor faults',
      columns: ['Detected', 'Device', 'Metric', 'Type', 'Scope', 'Details'],
      rows: faults.map((f) => [
        timeLabel(f.detected_at),
        f.device,
        f.metric,
        f.fault_type,
        f.astronaut_id ? 'astronaut' : 'cabin',
        f.details ?? '—',
      ]),
      empty: 'No sensor faults in this period.',
    });

    report.layout = 'landscape';
    report.notes.push(
      'Reliability statistics describe the trust layer output. They do not describe the astronaut’s clinical state.',
    );
  }

  return report;
}

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------
function pdfSafe(value) {
  return String(value ?? '')
    .replace(/µ/g, 'u')
    .replace(/±/g, '+/-')
    .replace(/°C/g, ' deg C')
    .replace(/°/g, ' deg ')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–/g, '-')
    .replace(/—/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '?');
}

export function streamReportPdf(report, res) {
  const astronautSlug = report.astronaut?.name
    ? `-${report.astronaut.name
        .replace(/[^\w]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()}`
    : '';
  const filename = `vitalis-${report.type}${astronautSlug}-${report.period.from}-to-${report.period.to}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({
    size: 'A4',
    layout: report.layout === 'landscape' ? 'landscape' : 'portrait',
    margin: 40,
    info: {
      Title: `VITALIS - ${report.title}`,
      Author: 'VITALIS',
      Subject: 'Decision support report',
    },
  });
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const accent = '#0A8FB5';
  const ink = '#0B1020';
  const muted = '#5B6780';

  doc.fillColor(accent).fontSize(9).font('Helvetica-Bold').text('ASTROGUARD AI', margin, y);
  doc.fillColor(muted).font('Helvetica').fontSize(8).text('Mission health decision support', margin, y + 12);
  y += 34;

  doc.fillColor(ink).font('Helvetica-Bold').fontSize(19).text(pdfSafe(report.title), margin, y, { width: contentWidth });
  y = doc.y + 6;

  const meta = [
    `Generated: ${timeLabel(report.generatedAt)}`,
    `Period: ${report.period.from} to ${report.period.to}`,
    report.mission ? `Mission: ${report.mission.name} (Day ${report.mission.day} of ${report.mission.totalDays})` : null,
    report.astronaut ? `Crew member: ${report.astronaut.name}` : 'Scope: cabin-wide',
  ].filter(Boolean);
  doc.fillColor(muted).font('Helvetica').fontSize(8.5);
  doc.text(meta.join('   |   '), margin, y, { width: contentWidth });
  y = doc.y + 12;

  // Decision-support note is required in every PDF, at the top and bottom.
  const noteHeight = doc.heightOfString(pdfSafe(report.note), { width: contentWidth - 16 }) + 12;
  doc.save();
  doc.roundedRect(margin, y, contentWidth, noteHeight, 4).fill('#EAF7FB');
  doc.fillColor('#064E60').font('Helvetica-Bold').fontSize(8).text('Decision support, not a medical diagnosis.', margin + 8, y + 6);
  doc.font('Helvetica').fontSize(7.6).text(pdfSafe(report.note), margin + 8, y + 17, { width: contentWidth - 16 });
  doc.restore();
  y += noteHeight + 12;

  // Summary grid
  if (report.summary.length) {
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(11).text('Summary', margin, y);
    y = doc.y + 6;
    const cols = 4;
    const cellWidth = contentWidth / cols;
    const rows = Math.ceil(report.summary.length / cols);
    for (let i = 0; i < report.summary.length; i += 1) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = margin + col * cellWidth;
      const cy = y + row * 34;
      doc.fillColor(muted).font('Helvetica').fontSize(7.5).text(pdfSafe(report.summary[i].label).toUpperCase(), x, cy, { width: cellWidth - 6 });
      doc.fillColor(ink).font('Helvetica-Bold').fontSize(10.5).text(pdfSafe(report.summary[i].value), x, cy + 10, { width: cellWidth - 6 });
    }
    y += rows * 34 + 8;
  }

  const bottomLimit = pageHeight - 64;

  // Tables
  for (const table of report.tables) {
    const colCount = table.columns.length;
    const colWidth = contentWidth / colCount;

    // Estimate header + first row to decide on a page break.
    const needed = 28;
    if (y + needed > bottomLimit) {
      doc.addPage();
      y = margin;
    }

    doc.fillColor(ink).font('Helvetica-Bold').fontSize(10.5).text(pdfSafe(table.title), margin, y);
    y = doc.y + 4;

    if (!table.rows.length) {
      doc.fillColor(muted).font('Helvetica-Oblique').fontSize(8.5).text(pdfSafe(table.empty ?? 'No data.'), margin, y);
      y = doc.y + 14;
      continue;
    }

    // Header
    const headerHeight = 18;
    doc.save();
    doc.rect(margin, y, contentWidth, headerHeight).fill('#EEF4F8');
    doc.restore();
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(7.5);
    table.columns.forEach((column, index) => {
      doc.text(pdfSafe(column), margin + index * colWidth + 4, y + 5, {
        width: colWidth - 8,
        lineBreak: false,
      });
    });
    y += headerHeight;

    doc.font('Helvetica').fontSize(7.2).fillColor(ink);
    for (const row of table.rows) {
      const texts = row.map((cell) => pdfSafe(cell));
      let rowHeight = 0;
      texts.forEach((text, index) => {
        const h = doc.heightOfString(text, { width: colWidth - 8 });
        if (h > rowHeight) rowHeight = h;
      });
      rowHeight += 8;

      if (y + rowHeight > bottomLimit) {
        doc.addPage();
        y = margin;
        doc.save();
        doc.rect(margin, y, contentWidth, headerHeight).fill('#EEF4F8');
        doc.restore();
        doc.fillColor(ink).font('Helvetica-Bold').fontSize(7.5);
        table.columns.forEach((column, index) => {
          doc.text(pdfSafe(column), margin + index * colWidth + 4, y + 5, {
            width: colWidth - 8,
            lineBreak: false,
          });
        });
        y += headerHeight;
        doc.font('Helvetica').fontSize(7.2).fillColor(ink);
      }

      // Zebra rows aid readability and are not the only signal.
      if (Math.floor(table.rows.indexOf(row) % 2) === 1) {
        doc.save();
        doc.rect(margin, y, contentWidth, rowHeight).fill('#F7F9FC');
        doc.restore();
        doc.fillColor(ink);
      }
      texts.forEach((text, index) => {
        doc.text(text, margin + index * colWidth + 4, y + 4, {
          width: colWidth - 8,
          height: rowHeight - 6,
        });
      });

      doc.save();
      doc.strokeColor('#E3E8F2').lineWidth(0.5)
        .moveTo(margin, y + rowHeight).lineTo(margin + contentWidth, y + rowHeight).stroke();
      doc.restore();

      y += rowHeight;
    }
    y += 14;
  }

  if (report.notes.length) {
    if (y + 40 > bottomLimit) {
      doc.addPage();
      y = margin;
    }
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(10).text('Notes', margin, y);
    y = doc.y + 4;
    doc.fillColor(muted).font('Helvetica').fontSize(8);
    for (const note of report.notes) {
      doc.text(`- ${pdfSafe(note)}`, margin, y, { width: contentWidth });
      y = doc.y + 4;
    }
  }

  if (y + 40 > bottomLimit) {
    doc.addPage();
    y = margin;
  }
  y = Math.max(y + 8, pageHeight - margin - 30);
  doc.fillColor('#064E60').font('Helvetica-Bold').fontSize(8.5)
    .text('Decision support, not a medical diagnosis.', margin, y, { width: contentWidth, align: 'center' });
  doc.fillColor(muted).font('Helvetica').fontSize(7)
    .text(`VITALIS - ${pdfSafe(report.mission?.name ?? 'Mission')} - ${timeLabel(report.generatedAt)}`, margin, y + 13, {
      width: contentWidth,
      align: 'center',
    });

  doc.end();
}
