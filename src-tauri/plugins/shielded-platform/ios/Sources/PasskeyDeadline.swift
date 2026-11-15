import Foundation

final class PasskeyDeadline {
    typealias Schedule = (TimeInterval, @escaping () -> Void) -> DispatchWorkItem
    private final class Ticket {}
    private let schedule: Schedule
    private var ticket: Ticket?
    private var work: DispatchWorkItem?

    init(schedule: @escaping Schedule = { seconds, fire in
        let work = DispatchWorkItem(block: fire)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
        return work
    }) { self.schedule = schedule }

    func arm(after seconds: TimeInterval = 120, expire: @escaping () -> Void) {
        cancel()
        let current = Ticket()
        ticket = current
        let next = schedule(seconds) { [weak self] in
            guard let self = self, self.ticket === current else { return }
            self.ticket = nil
            self.work = nil
            expire()
        }
        if ticket === current { work = next } else { next.cancel() }
    }

    func cancel() {
        ticket = nil
        let previous = work
        work = nil
        previous?.cancel()
    }

    deinit { cancel() }
}
