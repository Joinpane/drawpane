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
    /// When the last submission known done was made: past `KEEP` the times of some unfinished
    /// ones are let go, and the oldest of those is no younger than this.
    done_at: Option<f64>,
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
        while let Some(&(seq, sent)) = self.sent.front()
            && seq <= done
        {
            self.done_at = Some(sent);
            self.sent.pop_front();
        }
        let Some(&(seq, sent)) = self.sent.front() else {
            return false;
        };
        // The oldest unfinished submission is the one after the last done. When its time was let
        // go, the last done one's is older still: the wait gives up no later than it should.
        let oldest = if seq == done + 1 {
            sent
        } else {
            self.done_at.unwrap_or(sent)
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

/// What the canvas shows of the frames kept: the frame a render-limit stand-in was shown from
/// (`Gpu::present_motion_standin`), while the frame it was warped from stays the one the next is
/// laid on. Older than the screen where something changed since, that frame is then laid round
/// it (`TileCache::base_kept`).
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Screen {
    /// The frame (`frames` index) holding the stand-in shown, if one is.
    pub standin: Option<usize>,
}

impl Screen {
    /// A frame went for the canvas (`Gpu::acquire`'s answer, `canvas` false when frames are read
    /// back instead). Whether it's shown now: only a frame the canvas took, or one read back,
    /// replaces what's on screen. When the canvas fails, or can't take a frame now, what was
    /// shown stays, and so does the record of it.
    pub fn acquired<T, E>(&mut self, canvas: bool, acquired: &Result<Option<T>, E>) -> bool {
        let shown = match acquired {
            Ok(Some(_)) => true,
            Ok(None) => !canvas,
            Err(_) => false,
        };
        if shown {
            self.standin = None;
        }
        shown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in on screen stays recorded until a frame actually replaces it: not when the
    /// canvas fails to give a texture, nor when it can't take one now (issue #355: the engine
    /// then thought the older kept frame was on screen, and laid it uncut).
    #[test]
    fn a_stand_in_stays_recorded_until_a_frame_is_shown() {
        let mut screen = Screen { standin: Some(1) };
        assert!(!screen.acquired::<(), &str>(true, &Err("the canvas's surface was lost")));
        assert_eq!(screen.standin, Some(1), "an acquire that failed showed nothing");
        assert!(!screen.acquired::<(), &str>(true, &Ok(None)));
        assert_eq!(screen.standin, Some(1), "a canvas that took nothing showed nothing");
        assert!(screen.acquired::<(), &str>(true, &Ok(Some(()))));
        assert_eq!(screen.standin, None, "a frame shown replaces the stand-in");
        // No canvas: frames are read back, so each one drawn is what's shown.
        let mut read_back = Screen { standin: Some(0) };
        assert!(read_back.acquired::<(), &str>(false, &Ok(None)));
        assert_eq!(read_back.standin, None);
    }

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

    /// Past the history kept, a partial completion never brings back a wait the real oldest
    /// unfinished submission has outlived (re-check of #345).
    #[test]
    fn partial_progress_keeps_the_age_of_the_oldest_unfinished_submission() {
        let mut f = InFlight::default();
        for i in 0..100 {
            f.submitted(f64::from(i) * 3.0);
        }
        assert!(!f.behind(0, 0, 300.0));
        // Only the first is done: the second, sent at 3 ms, is 297 ms old.
        assert!(!f.behind(1, 0, 300.0));
        assert!(!f.behind(1, 0, 301.0));
    }

    #[test]
    fn signals_after_a_pause_never_renew_the_wait() {
        let mut f = InFlight::default();
        f.submitted(0.0);
        assert!(f.behind(0, 0, 50.0));
        f.submitted(1500.0);
        assert!(!f.behind(0, 0, 1501.0));
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
