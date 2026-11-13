---- MODULE IndexerStreams ----
EXTENDS Naturals, FiniteSets

CONSTANTS Scripts, MaxAttempts, MaxFaults, MaxEvents,
          BreakCatchUp, BreakLostEscalation, BreakBound, BreakIsolation
VARIABLES state, attempts, missed, lost, escalated, torn, faults, events

vars == <<state, attempts, missed, lost, escalated, torn, faults, events>>
Phases == {"live", "broken", "backoff", "handed"}
Kinds == {"describable", "lost"}

Init == /\ state = [s \in Scripts |-> "live"]
        /\ attempts = [s \in Scripts |-> 0]
        /\ missed = [s \in Scripts |-> FALSE]
        /\ lost = [s \in Scripts |-> FALSE]
        /\ escalated = FALSE /\ torn = 0
        /\ faults = 0 /\ events = 0

\* One script's stream or poll fails. Isolation keeps every sibling attached.
Fail(s) ==
    /\ state[s] = "live" /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ state' = [state EXCEPT ![s] = "broken"]
    /\ torn' = IF BreakIsolation
               THEN torn + Cardinality({t \in Scripts : t # s /\ state[t] = "live"})
               ELSE torn
    /\ UNCHANGED <<attempts, missed, lost, escalated, events>>

\* An indexer change for s. Off-stream it is lost at the server until a read recovers it.
Event(s, kind) ==
    /\ events < MaxEvents
    /\ events' = events + 1
    /\ IF state[s] = "live"
       THEN UNCHANGED <<missed, lost>>
       ELSE /\ missed' = [missed EXCEPT ![s] = TRUE]
            /\ lost' = IF kind = "lost" THEN [lost EXCEPT ![s] = TRUE] ELSE lost
    /\ UNCHANGED <<state, attempts, escalated, torn, faults>>

Backoff(s) ==
    /\ state[s] = "broken"
    /\ attempts[s] < MaxAttempts + 1
    /\ (BreakBound \/ attempts[s] < MaxAttempts)
    /\ state' = [state EXCEPT ![s] = "backoff"]
    /\ attempts' = [attempts EXCEPT ![s] = attempts[s] + 1]
    /\ UNCHANGED <<missed, lost, escalated, torn, faults, events>>

\* The retry budget ran out, so the whole logical stream is handed to the SDK.
Escalate(s) ==
    /\ state[s] = "broken" /\ ~BreakBound /\ attempts[s] >= MaxAttempts
    /\ state' = [state EXCEPT ![s] = "handed"]
    /\ escalated' = TRUE
    /\ UNCHANGED <<attempts, missed, lost, torn, faults, events>>

\* The catch-up read before resuming. A coin it can no longer describe needs the SDK's reset.
CatchUp(s) ==
    /\ state[s] = "backoff"
    /\ IF lost[s] /\ ~BreakLostEscalation
       THEN /\ state' = [state EXCEPT ![s] = "handed"]
            /\ escalated' = TRUE
            /\ UNCHANGED <<missed, lost>>
       ELSE /\ state' = [state EXCEPT ![s] = "live"]
            /\ missed' = IF BreakCatchUp THEN missed ELSE [missed EXCEPT ![s] = FALSE]
            /\ UNCHANGED <<lost, escalated>>
    /\ UNCHANGED <<attempts, torn, faults, events>>

CatchUpFails(s) ==
    /\ state[s] = "backoff" /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ state' = [state EXCEPT ![s] = "broken"]
    /\ UNCHANGED <<attempts, missed, lost, escalated, torn, events>>

\* connection_reset: the SDK clears its watermarks and re-reads every watched script.
SdkReset ==
    /\ escalated /\ \E s \in Scripts : state[s] = "handed"
    /\ state' = [s \in Scripts |-> "live"]
    /\ attempts' = [s \in Scripts |-> 0]
    /\ missed' = [s \in Scripts |-> FALSE]
    /\ lost' = [s \in Scripts |-> FALSE]
    /\ UNCHANGED <<escalated, torn, faults, events>>

Terminal == UNCHANGED vars
Next == \/ \E s \in Scripts : Fail(s) \/ Backoff(s) \/ Escalate(s)
                              \/ CatchUp(s) \/ CatchUpFails(s)
        \/ \E s \in Scripts, k \in Kinds : Event(s, k)
        \/ SdkReset \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK == /\ state \in [Scripts -> Phases]
          /\ attempts \in [Scripts -> 0..(MaxAttempts + 1)]
          /\ missed \in [Scripts -> BOOLEAN] /\ lost \in [Scripts -> BOOLEAN]
          /\ escalated \in BOOLEAN
          /\ torn \in Nat /\ faults \in 0..MaxFaults /\ events \in 0..MaxEvents
\* A script back on its stream owes nothing from the gap it was away for.
NoMissedEvent == \A s \in Scripts : state[s] = "live" => ~missed[s] /\ ~lost[s]
\* A script that cannot resume is handed to the SDK, never retried in silence.
BoundedIsolatedRetry == \A s \in Scripts : attempts[s] <= MaxAttempts
\* One script's failure detaches no sibling.
NoCollateralTeardown == torn = 0
====
