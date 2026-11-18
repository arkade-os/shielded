import Foundation

private final class Scheduler {
    struct Job {
        let seconds: TimeInterval
        let fire: () -> Void
        let work: DispatchWorkItem
    }
    var jobs: [Job] = []

    func schedule(_ seconds: TimeInterval, _ fire: @escaping () -> Void) -> DispatchWorkItem {
        let work = DispatchWorkItem {}
        jobs.append(Job(seconds: seconds, fire: fire, work: work))
        return work
    }
}

@main
private struct ApplePasskeyDeadlineChecks {
    static func main() {
        missingCallbackExpiresOnce()
        completionCancelsDeadline()
        oldTimerCannotExpireNewRequest()
        releasedOwnerCancelsDeadline()
        print("Apple passkey deadline: 4 deterministic checks passed.")
    }

    static func missingCallbackExpiresOnce() {
        let scheduler = Scheduler(), deadline = PasskeyDeadline(schedule: scheduler.schedule)
        var expired = 0
        deadline.arm { expired += 1 }
        precondition(scheduler.jobs.count == 1 && scheduler.jobs[0].seconds == 120)
        scheduler.jobs[0].fire()
        scheduler.jobs[0].fire()
        precondition(expired == 1, "a missing callback must expire exactly once")
    }

    static func completionCancelsDeadline() {
        let scheduler = Scheduler(), deadline = PasskeyDeadline(schedule: scheduler.schedule)
        var expired = 0
        deadline.arm { expired += 1 }
        deadline.cancel()
        precondition(scheduler.jobs[0].work.isCancelled)
        scheduler.jobs[0].fire()
        precondition(expired == 0, "a completed prompt cannot expire later")
    }

    static func oldTimerCannotExpireNewRequest() {
        let scheduler = Scheduler(), deadline = PasskeyDeadline(schedule: scheduler.schedule)
        var expired: [String] = []
        deadline.arm { expired.append("old") }
        deadline.arm { expired.append("new") }
        precondition(scheduler.jobs[0].work.isCancelled && !scheduler.jobs[1].work.isCancelled)
        scheduler.jobs[0].fire()
        precondition(expired.isEmpty && !scheduler.jobs[1].work.isCancelled)
        scheduler.jobs[1].fire()
        scheduler.jobs[0].fire()
        precondition(expired == ["new"], "a queued old timer cannot affect a newer request")
    }

    static func releasedOwnerCancelsDeadline() {
        let scheduler = Scheduler()
        var deadline: PasskeyDeadline? = PasskeyDeadline(schedule: scheduler.schedule), expired = 0
        weak var observer = deadline
        deadline?.arm { expired += 1 }
        deadline = nil
        precondition(observer == nil && scheduler.jobs[0].work.isCancelled)
        scheduler.jobs[0].fire()
        precondition(expired == 0, "the queued callback must not retain its owner")
    }
}
