-- VITALIS - database schema
-- MySQL 8 compatible (also runs on MariaDB 10.4+).
-- Create the database first, then run:
--   mysql -u root -p vitalis < server/db/schema.sql
-- The app only WRITES user/wellness/notes/readiness/alert-action/assistant tables.
-- Monitoring tables (readings, ecg_segments, environment_readings,
-- radiation_readings, sleep_records, sensor_faults, alerts) are populated by
-- external processes and treated as read-only by the API.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NULL,
  role ENUM('admin', 'medical', 'astronaut') NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invites (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invites_token (token_hash),
  KEY idx_invites_user (user_id),
  CONSTRAINT fk_invites_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS missions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  radiation_limit_msv DECIMAL(8, 2) NOT NULL,
  exercise_target_min_per_day INT NOT NULL,
  PRIMARY KEY (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assignments (
  astronaut_id BIGINT UNSIGNED NOT NULL,
  medical_officer_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (astronaut_id),
  KEY idx_assignments_officer (medical_officer_id),
  CONSTRAINT fk_assignments_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_assignments_officer FOREIGN KEY (medical_officer_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS readiness (
  astronaut_id BIGINT UNSIGNED NOT NULL,
  status ENUM('fit', 'limited', 'unfit') NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (astronaut_id),
  CONSTRAINT fk_readiness_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_readiness_updater FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Monitoring data (externally written, read-only for the app)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS readings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  astronaut_id BIGINT UNSIGNED NOT NULL,
  metric ENUM('heart_rate', 'spo2', 'bp_systolic', 'bp_diastolic', 'body_temp', 'resp_rate') NOT NULL,
  value DECIMAL(8, 2) NOT NULL,
  unit VARCHAR(16) NOT NULL,
  ts DATETIME(3) NOT NULL,
  confidence DECIMAL(3, 2) NOT NULL,
  trust_status ENUM('trusted', 'suspect', 'excluded') NOT NULL,
  trust_reason VARCHAR(255) NULL,
  raw_value DECIMAL(8, 2) NULL,
  source_device VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_readings_astro_metric_ts (astronaut_id, metric, ts),
  UNIQUE KEY uq_readings (astronaut_id, metric, ts, source_device),
  CONSTRAINT fk_readings_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecg_segments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  astronaut_id BIGINT UNSIGNED NOT NULL,
  ts_start DATETIME(3) NOT NULL,
  sample_rate_hz INT NOT NULL,
  samples JSON NOT NULL,
  artifact_ranges JSON NULL,
  confidence DECIMAL(3, 2) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_ecg_astro_ts (astronaut_id, ts_start),
  CONSTRAINT fk_ecg_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS environment_readings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  metric ENUM('o2', 'co2', 'pressure', 'temperature', 'humidity', 'air_quality') NOT NULL,
  value DECIMAL(10, 3) NOT NULL,
  unit VARCHAR(16) NOT NULL,
  ts DATETIME(3) NOT NULL,
  confidence DECIMAL(3, 2) NOT NULL,
  trust_status ENUM('trusted', 'suspect', 'excluded') NOT NULL,
  trust_reason VARCHAR(255) NULL,
  source VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_env_metric_ts (metric, ts)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS radiation_readings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  astronaut_id BIGINT UNSIGNED NOT NULL,
  rate_usv_per_h DECIMAL(10, 3) NOT NULL,
  cumulative_msv DECIMAL(10, 4) NOT NULL,
  ts DATETIME(3) NOT NULL,
  confidence DECIMAL(3, 2) NOT NULL,
  trust_status ENUM('trusted', 'suspect', 'excluded') NOT NULL,
  trust_reason VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_rad_astro_ts (astronaut_id, ts),
  CONSTRAINT fk_rad_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sleep_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  astronaut_id BIGINT UNSIGNED NOT NULL,
  date DATE NOT NULL,
  duration_min INT NOT NULL,
  quality_score INT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sleep_astro_date (astronaut_id, date),
  CONSTRAINT fk_sleep_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metric_ranges (
  metric VARCHAR(32) NOT NULL,
  scope ENUM('health', 'environment') NOT NULL,
  safe_min DECIMAL(10, 3) NOT NULL,
  safe_max DECIMAL(10, 3) NOT NULL,
  critical_min DECIMAL(10, 3) NOT NULL,
  critical_max DECIMAL(10, 3) NOT NULL,
  unit VARCHAR(16) NOT NULL,
  PRIMARY KEY (metric)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS baselines (
  astronaut_id BIGINT UNSIGNED NOT NULL,
  metric VARCHAR(32) NOT NULL,
  mean DECIMAL(10, 3) NOT NULL,
  std DECIMAL(10, 3) NOT NULL,
  PRIMARY KEY (astronaut_id, metric),
  CONSTRAINT fk_baselines_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sensor_faults (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  astronaut_id BIGINT UNSIGNED NULL,
  device VARCHAR(64) NOT NULL,
  metric VARCHAR(32) NOT NULL,
  fault_type ENUM('noise', 'missing', 'drift', 'artifact', 'abnormal', 'conflict') NOT NULL,
  details TEXT NULL,
  detected_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_faults_astro_time (astronaut_id, detected_at),
  KEY idx_faults_time (detected_at),
  CONSTRAINT fk_faults_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS alerts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category ENUM('health', 'environment', 'radiation', 'device', 'wellness') NOT NULL,
  severity ENUM('normal', 'warning', 'critical') NOT NULL,
  astronaut_id BIGINT UNSIGNED NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  possible_causes JSON NULL,
  recommendation TEXT NULL,
  confidence DECIMAL(3, 2) NOT NULL,
  basis_text VARCHAR(255) NULL,
  confirmed_sensor_count INT NULL,
  related_metrics JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at DATETIME(3) NULL,
  acknowledged_by BIGINT UNSIGNED NULL,
  acknowledged_at DATETIME(3) NULL,
  escalated_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_alerts_astro_created (astronaut_id, created_at),
  KEY idx_alerts_category_severity (category, severity),
  KEY idx_alerts_resolved (resolved_at),
  CONSTRAINT fk_alerts_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_alerts_acknowledger FOREIGN KEY (acknowledged_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Data written by the app
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checkins (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  astronaut_id BIGINT UNSIGNED NOT NULL,
  date DATE NOT NULL,
  stress TINYINT NOT NULL,
  mood TINYINT NOT NULL,
  focus TINYINT NOT NULL,
  fatigue TINYINT NOT NULL,
  notes TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_checkins_astro_date (astronaut_id, date),
  CONSTRAINT fk_checkins_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_checkins_scale CHECK (
    stress BETWEEN 1 AND 5 AND mood BETWEEN 1 AND 5 AND
    focus BETWEEN 1 AND 5 AND fatigue BETWEEN 1 AND 5
  )
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS exercise_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  checkin_id BIGINT UNSIGNED NOT NULL,
  type ENUM('cardio', 'resistance', 'balance', 'other') NOT NULL,
  duration_min INT NOT NULL,
  intensity TINYINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_exercise_checkin (checkin_id),
  CONSTRAINT fk_exercise_checkin FOREIGN KEY (checkin_id) REFERENCES checkins (id) ON DELETE CASCADE,
  CONSTRAINT chk_exercise_intensity CHECK (intensity BETWEEN 1 AND 5)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS medical_notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  astronaut_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('note', 'instruction') NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_notes_astro_created (astronaut_id, created_at),
  CONSTRAINT fk_notes_astronaut FOREIGN KEY (astronaut_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_notes_author FOREIGN KEY (author_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assistant_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('user', 'assistant') NOT NULL,
  content TEXT NOT NULL,
  structured JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_assistant_user_created (user_id, created_at),
  CONSTRAINT fk_assistant_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
