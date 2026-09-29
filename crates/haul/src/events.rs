use serde::Serialize;
use tokio::sync::broadcast;

/// Everything the UI needs to stay current. Sent as Server-Sent Events.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    /// Rows changed; the UI refetches the affected lists.
    #[serde(rename_all = "camelCase")]
    Changed { topic: Topic },
    /// Live byte counters of running downloads, sent about once a second.
    #[serde(rename_all = "camelCase")]
    Progress {
        items: Vec<ProgressItem>,
        total_speed: u64,
        /// Packages being extracted and their percentage.
        extract: Vec<ExtractProgress>,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Topic {
    Downloads,
    Accounts,
    Plugins,
    Settings,
    /// Contents of the done folder.
    Files,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressItem {
    pub id: i64,
    pub bytes_done: u64,
    pub size: Option<u64>,
    /// Bytes per second, averaged over the last few seconds.
    pub speed: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractProgress {
    /// Folder being extracted, relative to the done folder.
    pub path: String,
    pub package_id: Option<i64>,
    pub percent: u8,
}

#[derive(Clone)]
pub struct Events {
    tx: broadcast::Sender<Event>,
}

impl Events {
    pub fn new() -> Self {
        Self {
            tx: broadcast::channel(256).0,
        }
    }

    pub fn send(&self, e: Event) {
        let _ = self.tx.send(e);
    }

    pub fn changed(&self, topic: Topic) {
        self.send(Event::Changed { topic });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}
