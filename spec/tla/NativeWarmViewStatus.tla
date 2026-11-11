------------------------- MODULE NativeWarmViewStatus -------------------------
EXTENDS Naturals

(* NativeEvent is event application; polls capture then deliver independently.
   Planned native status revision and frontend status/event acceptance boundary. *)

CONSTANTS MaxRevision, MaxGeneration, BreakPollFence
VARIABLE s
vars == <<s>>

Init == s = [active |-> TRUE, phase |-> "ready", gen |-> 1, revision |-> 0,
    observedActive |-> TRUE, observedPhase |-> "ready", observedGen |-> 1, observedRev |-> 0,
    poll |-> "idle", captured |-> [active |-> TRUE, phase |-> "ready", gen |-> 1, revision |-> 0],
    badPoll |-> FALSE]

Suspend ==
    /\ s.active /\ s.revision < MaxRevision /\ s.gen < MaxGeneration
    /\ s' = [s EXCEPT !.active = FALSE, !.phase = "paused", !.gen = @ + 1,
        !.revision = @ + 1, !.observedActive = FALSE, !.observedPhase = "paused",
        !.observedGen = s.gen + 1, !.observedRev = s.revision + 1]

Resumed ==
    /\ ~s.active /\ s.revision < MaxRevision
    /\ s' = [s EXCEPT !.active = TRUE, !.revision = @ + 1,
        !.observedActive = TRUE, !.observedRev = s.revision + 1]

ReadPoll ==
    /\ s.poll = "idle"
    /\ s' = [s EXCEPT !.poll = "pending", !.captured =
        [active |-> s.active, phase |-> s.phase, gen |-> s.gen, revision |-> s.revision]]

DeliverPoll ==
    /\ s.poll = "pending"
    /\ IF s.captured.gen = s.gen /\ (s.captured.revision >= s.observedRev \/ BreakPollFence)
       THEN s' = [s EXCEPT !.poll = "done", !.observedActive = s.captured.active,
            !.observedPhase = s.captured.phase, !.observedGen = s.captured.gen,
            !.observedRev = s.captured.revision,
            !.badPoll = @ \/ (s.captured.revision < s.observedRev)]
       ELSE s' = [s EXCEPT !.poll = "done"]

Next == Suspend \/ Resumed \/ ReadPoll \/ DeliverPoll
TypeOK == s \in [active: BOOLEAN, phase: {"ready", "paused"}, gen: 1..MaxGeneration,
    revision: 0..MaxRevision, observedActive: BOOLEAN, observedPhase: {"ready", "paused"},
    observedGen: 1..MaxGeneration, observedRev: 0..MaxRevision, poll: {"idle", "pending", "done"},
    captured: [active: BOOLEAN, phase: {"ready", "paused"}, gen: 1..MaxGeneration,
        revision: 0..MaxRevision], badPoll: BOOLEAN]
NoPollUndoNativeEvent == ~s.badPoll
Spec == Init /\ [][Next]_vars
=============================================================================
