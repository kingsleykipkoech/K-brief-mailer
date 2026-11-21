CREATE DATABASE IF NOT EXISTS kbail CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE kbail;

CREATE TABLE IF NOT EXISTS raw_emails (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_email VARCHAR(255) NOT NULL,
  message_id VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  sender VARCHAR(255) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  received_at DATETIME NOT NULL,
  extracted_dates JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_msg (user_email, message_id)
);

CREATE TABLE IF NOT EXISTS email_summaries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  raw_email_id INT NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  sender VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  time_label VARCHAR(64) NOT NULL,
  summary_points JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_raw_email (raw_email_id),
  FOREIGN KEY (raw_email_id) REFERENCES raw_emails(id) ON DELETE CASCADE
);
