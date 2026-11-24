//! How much GPU work the backend lets queue, as plain bookkeeping (decision 0040, "zooming out on
//! stand-ins"): the submissions not known done, and moving frames starved of tile work.

use std::collections::VecDeque;

/// Back-pressure gives up once the oldest submission not known done is this old: a lost device
/// never answers, and newer submissions never renew the wait.
pub const GIVE_UP_MS: f64 = 250.0;
/// Unfinished submissions remembered: the oldest always stays.
const KEEP: usize = 64;
/// A moving frame that has started no tile work for this long, while some was wanted, starts
/// one bounded unit anyway (a resumable tile walk, paused at the pass cap).
pub const STARVE_MS: f64 = 100.0;

/// Submissions to the GPU and how many it has finished.
#[derive(Default)]
pub struct InFlight {
    seq: u64,
    sent: VecDeque<(u64, f64)>,
}

impl InFlight {
    /// A submission made at `at` (milliseconds): its sequence number, which its completion
    /// reports back as done.
    pub fn submitted(&mut self, at: f64) -> u64 {
        self.seq += 1;
        self.sent.push_back((self.seq, at));
        if self.sent.len() > KEEP {
            self.sent.remove(1);
        }
        self.seq
    }

    /// Whether more than `in_flight` submissions aren't done (`done`, the highest sequence
    /// reported done) at `at`, unless the oldest of them is `GIVE_UP_MS` old.
    pub fn behind(&mut self, done: u64, in_flight: u64, at: f64) -> bool {
        while self.sent.front().is_some_and(|(seq, _)| *seq <= done) {
            self.sent.pop_front();
        }
        let Some(&(_, oldest)) = self.sent.front() else {
            return false;
        };
        done + in_flight < self.seq && at - oldest < GIVE_UP_MS
    }
}

/// Moving frames that started no tile work while some was wanted.
#[derive(Default)]
pub struct Starvation {
    since: Option<f64>,
}

impl Starvation {
    /// Whether a frame at `at` must start one bounded unit whatever holds work back.
    pub fn starved(&self, at: f64) -> bool {
        self.since.is_some_and(|t| at - t >= STARVE_MS)
    }

    /// A frame started tile work, or isn't moving.
    pub fn fed(&mut self) {
        self.since = None;
    }

    /// A moving frame at `at` wanted tile work and started none.
    pub fn hungry(&mut self, at: f64) {
        self.since.get_or_insert(at);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in presented every frame never renews the wait: the oldest unfinished submission
    /// decides, so a silent GPU holds tile work back for `GIVE_UP_MS` at most (review of #345).
    #[test]
    fn newer_submissions_never_renew_the_wait() {
        let mut f = InFlight::default();
        let mut at = 0.0;
        f.submitted(at);
        let mut behind_until = 0.0;
        while at < 1000.0 {
            at += 16.7;
            f.submitted(at);
            if f.behind(0, 0, at) {
                behind_until = at;
            }
        }
        assert!(behind_until > 200.0 && behind_until < GIVE_UP_MS, "{behind_until}");
        // Progress: the next unfinished one is the oldest now, and it's fresh enough again.
        let seq = f.submitted(at);
        assert!(f.behind(seq - 2, 0, at + 1.0));
        assert!(!f.behind(seq, 0, at + 1.0));
        // Two in flight are allowed between frames.
        let next = f.submitted(at + 2.0);
        assert!(!f.behind(next - 2, 2, at + 3.0));
    }

    #[test]
    fn a_starved_motion_starts_a_unit_after_a_while() {
        let mut s = Starvation::default();
        assert!(!s.starved(0.0));
        s.hungry(10.0);
        s.hungry(50.0);
        assert!(!s.starved(100.0));
        assert!(s.starved(110.0));
        s.fed();
        assert!(!s.starved(500.0));
    }
}
