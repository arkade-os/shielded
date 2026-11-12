----------------------- MODULE NativeContinuityStatus -----------------------
EXTENDS Naturals, Sequences

(* Flip: lib.rs window Suspended/Resumed -> Inner::suspend(true)/resumed.
   Accept: NativeBridge.acceptLifecycle receives the emitted event in order.
   Issue/Read/Deliver: NativeBridge.status; native reads follow issue order,
   responses may resolve in any order. *)
CONSTANTS MaxFlips, MaxPolls, BreakPollFence, BreakPollOrder
Polls == {1, 2}
VARIABLE s
vars == <<s>>

Init == s = [foreground |-> TRUE, clock |-> 0, events |-> <<>>, revision |-> 0,
    observed |-> TRUE, observedAt |-> 0, acceptedSeq |-> 0, nextSeq |-> 1, readSeq |-> 0,
    poll |-> [p \in Polls |-> [state |-> "idle", seq |-> 0, revision |-> 0,
        value |-> TRUE, at |-> 0]],
    bad |-> FALSE]

Flip ==
    /\ s.clock < MaxFlips
    /\ s' = [s EXCEPT !.foreground = ~@, !.clock = @ + 1,
        !.events = Append(@, [value |-> ~s.foreground, at |-> s.clock + 1])]

Accept ==
    /\ s.events # <<>>
    /\ s' = [s EXCEPT !.events = Tail(@), !.revision = @ + 1,
        !.observed = Head(s.events).value, !.observedAt = Head(s.events).at]

Issue(p) ==
    /\ s.poll[p].state \in {"idle", "done"} /\ s.nextSeq <= MaxPolls
    /\ s' = [s EXCEPT !.nextSeq = @ + 1,
        !.poll[p] = [state |-> "issued", seq |-> s.nextSeq, revision |-> s.revision,
            value |-> TRUE, at |-> 0]]

Read(p) ==
    /\ s.poll[p].state = "issued" /\ s.poll[p].seq = s.readSeq + 1
    /\ s' = [s EXCEPT !.readSeq = @ + 1,
        !.poll[p] = [@ EXCEPT !.state = "read", !.value = s.foreground, !.at = s.clock]]

Deliver(p) ==
    /\ s.poll[p].state = "read"
    /\ LET q == s.poll[p]
           fresh == (q.revision = s.revision \/ BreakPollFence)
               /\ (q.seq > s.acceptedSeq \/ BreakPollOrder)
       IN s' = IF fresh
               THEN [s EXCEPT !.poll[p].state = "done", !.observed = q.value,
                   !.observedAt = q.at, !.acceptedSeq = q.seq,
                   !.bad = @ \/ q.at < s.observedAt]
               ELSE [s EXCEPT !.poll[p].state = "done"]

Next == Flip \/ Accept \/ \E p \in Polls: Issue(p) \/ Read(p) \/ Deliver(p)

TypeOK ==
    /\ s.foreground \in BOOLEAN /\ s.observed \in BOOLEAN /\ s.bad \in BOOLEAN
    /\ s.clock \in 0..MaxFlips /\ s.observedAt \in 0..MaxFlips
    /\ s.revision \in 0..MaxFlips /\ s.acceptedSeq \in 0..MaxPolls
    /\ s.nextSeq \in 1..(MaxPolls + 1) /\ s.readSeq \in 0..MaxPolls
    /\ \A p \in Polls: s.poll[p].state \in {"idle", "issued", "read", "done"}
NoStalePollObservation == ~s.bad
Spec == Init /\ [][Next]_vars
=============================================================================
