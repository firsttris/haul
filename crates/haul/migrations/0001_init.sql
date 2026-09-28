CREATE TABLE packages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    target_dir   TEXT    NOT NULL,
    source       TEXT    NOT NULL DEFAULT 'manual',
    source_page  TEXT,
    passwords    TEXT,
    collector    INTEGER NOT NULL DEFAULT 1,
    extract      TEXT,
    extract_error TEXT,
    created_at   INTEGER NOT NULL
);

CREATE TABLE downloads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id  INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    url         TEXT    NOT NULL,
    plugin_id   TEXT,
    status      TEXT    NOT NULL,
    online      TEXT    NOT NULL DEFAULT 'unknown',
    name        TEXT    NOT NULL,
    size        INTEGER,
    bytes_done  INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    retry_at    INTEGER,
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
);
CREATE INDEX downloads_package ON downloads(package_id);
CREATE INDEX downloads_status ON downloads(status);

CREATE TABLE segments (
    download_id INTEGER NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    start       INTEGER NOT NULL,
    "end"       INTEGER,
    done        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (download_id, idx)
);

CREATE TABLE accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id    TEXT    NOT NULL,
    user         TEXT    NOT NULL,
    secret       TEXT    NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    status       TEXT    NOT NULL DEFAULT 'unchecked',
    premium      INTEGER,
    traffic_left INTEGER,
    valid_until  INTEGER,
    error        TEXT,
    checked_at   INTEGER,
    created_at   INTEGER NOT NULL
);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
