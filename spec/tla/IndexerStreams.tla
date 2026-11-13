---- MODULE IndexerStreams ----
EXTENDS Naturals, FiniteSets

CONSTANTS Scripts, MaxAttempts, MaxFaults, MaxEvents,
          BreakCatchUp, BreakLostEscalation, BreakBound, BreakIsolation,
          BreakReopenOrder, BreakBaseline, BreakMonotonicFold
VARIABLES state, attempts, missed, lost, baseline, snapSpent, reading, stale,
          escalated, torn, faults, events

vars == <<state, attempts, missed, lost, baseline, snapSpent, reading, stale,
          escalated, torn, faults, events>>
\* "read" only exists when the read is ordered before the reopen (BreakReopenOrder): the
\* read has already answered but the stream is not back, so nothing covers that window.
Phases == {"live", "broken", "backoff", "reopened", "read", "handed"}
Kinds == {"describable", "lost"}
\* Off-stream: the server drops this script's events until a read recovers them.
Dark(s) == state[s] \in {"broken", "backoff", "read"}
\* Where the catch-up read is taken, and what the script resumes into.
ReadFrom == IF BreakReopenOrder THEN "backoff" ELSE "reopened"
Resumed == IF BreakReopenOrder THEN "read" ELSE "live"

Init == /\ state = [s \in Scripts |-> "live"]
        /\ attempts = [s \in Scripts |-> 0]
        /\ missed = [s \in Scripts |-> FALSE]
        /\ lost = [s \in Scripts |-> FALSE]
        /\ baseline = [s \in Scripts |-> TRUE]
        /\ snapSpent = [s \in Scripts |-> FALSE]
        /\ reading = [s \in Scripts |-> FALSE]
        /\ stale = [s \in Scripts |-> FALSE]
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
    /\ UNCHANGED <<attempts, missed, lost, baseline, snapSpent, reading, stale,
                   escalated, events>>

\* The seed read that gives a streamed script its first snapshot can fail too.
LoseBaseline(s) ==
    /\ baseline[s] /\ state[s] = "live" /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ baseline' = [baseline EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<state, attempts, missed, lost, snapSpent, reading, stale,
                   escalated, torn, events>>

\* An indexer change for s. Dark, it is lost at the server until a read recovers it.
Event(s, kind) ==
    /\ events < MaxEvents
    /\ events' = events + 1
    /\ IF Dark(s)
       THEN /\ missed' = [missed EXCEPT ![s] = TRUE]
            /\ lost' = IF kind = "lost" THEN [lost EXCEPT ![s] = TRUE] ELSE lost
       ELSE UNCHANGED <<missed, lost>>
    /\ UNCHANGED <<state, attempts, baseline, snapSpent, reading, stale,
                   escalated, torn, faults>>

Backoff(s) ==
    /\ state[s] = "broken"
    /\ attempts[s] < MaxAttempts + 1
    /\ (BreakBound \/ attempts[s] < MaxAttempts)
    /\ state' = [state EXCEPT ![s] = "backoff"]
    /\ attempts' = [attempts EXCEPT ![s] = attempts[s] + 1]
    /\ UNCHANGED <<missed, lost, baseline, snapSpent, reading, stale,
                   escalated, torn, faults, events>>

\* The retry budget ran out, so the whole logical stream is handed to the SDK.
Escalate(s) ==
    /\ state[s] = "broken" /\ ~BreakBound /\ attempts[s] >= MaxAttempts
    /\ state' = [state EXCEPT ![s] = "handed"]
    /\ escalated' = TRUE
    /\ UNCHANGED <<attempts, missed, lost, baseline, snapSpent, reading, stale,
                   torn, faults, events>>

\* Resume the stream BEFORE re-reading, so an event during the read arrives on it.
Reopen(s) ==
    /\ state[s] = IF BreakReopenOrder THEN "read" ELSE "backoff"
    /\ state' = [state EXCEPT ![s] = IF BreakReopenOrder THEN "live" ELSE "reopened"]
    /\ UNCHANGED <<attempts, missed, lost, baseline, snapSpent, reading, stale,
                   escalated, torn, faults, events>>

\* Whether the server replays this subscription id's buffered events is not assumed either way.
ReopenReplays(s) ==
    /\ state[s] = "reopened"
    /\ missed' = [missed EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<state, attempts, lost, baseline, snapSpent, reading, stale,
                   escalated, torn, faults, events>>

\* The catch-up read leaves and answers in separate steps, so the reopened stream can
\* overtake it. `reading` is the window a stream event can land in.
StartRead(s) ==
    /\ state[s] = ReadFrom /\ ~reading[s]
    /\ reading' = [reading EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<state, attempts, missed, lost, baseline, snapSpent, stale,
                   escalated, torn, faults, events>>

\* The reopened stream marks the coin spent while that older read is still in flight.
AbsorbSpend(s) ==
    /\ state[s] = "live" \/ state[s] = "reopened"
    /\ ~snapSpent[s]
    /\ snapSpent' = [snapSpent EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<state, attempts, missed, lost, baseline, reading, stale,
                   escalated, torn, faults, events>>

\* Folding the read's older view back in must not walk the snapshot backwards.
FoldRead(s) ==
    /\ reading[s]
    /\ reading' = [reading EXCEPT ![s] = FALSE]
    /\ stale' = IF snapSpent[s] /\ BreakMonotonicFold
                THEN [stale EXCEPT ![s] = TRUE] ELSE stale
    /\ snapSpent' = IF snapSpent[s] /\ BreakMonotonicFold
                    THEN [snapSpent EXCEPT ![s] = FALSE] ELSE snapSpent
    /\ UNCHANGED <<state, attempts, missed, lost, baseline, escalated, torn,
                   faults, events>>

\* The catch-up read. Without a snapshot it recovers describable changes but cannot see a coin go missing.
CatchUpRead(s) ==
    /\ state[s] = ReadFrom /\ ~reading[s]
    /\ IF ~baseline[s]
       THEN IF BreakBaseline
            THEN /\ state' = [state EXCEPT ![s] = Resumed]
                 /\ missed' = [missed EXCEPT ![s] = FALSE]
                 /\ baseline' = [baseline EXCEPT ![s] = TRUE]
                 /\ UNCHANGED <<lost, escalated>>
            ELSE /\ state' = [state EXCEPT ![s] = "handed"]
                 /\ escalated' = TRUE
                 /\ UNCHANGED <<missed, lost, baseline>>
       ELSE IF lost[s] /\ ~BreakLostEscalation
            THEN /\ state' = [state EXCEPT ![s] = "handed"]
                 /\ escalated' = TRUE
                 /\ UNCHANGED <<missed, lost, baseline>>
            ELSE /\ state' = [state EXCEPT ![s] = Resumed]
                 /\ missed' = IF BreakCatchUp THEN missed ELSE [missed EXCEPT ![s] = FALSE]
                 /\ UNCHANGED <<lost, baseline, escalated>>
    /\ UNCHANGED <<attempts, snapSpent, reading, stale, torn, faults, events>>

\* A read that cannot answer leaves the gap uncovered, so it is owed, not swallowed.
CatchUpFails(s) ==
    /\ state[s] = ReadFrom /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ state' = [state EXCEPT ![s] = "broken"]
    /\ reading' = [reading EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<attempts, missed, lost, baseline, snapSpent, stale,
                   escalated, torn, events>>

\* connection_reset: the SDK clears its watermarks and re-reads every watched script.
SdkReset ==
    /\ escalated /\ \E s \in Scripts : state[s] = "handed"
    /\ state' = [s \in Scripts |-> "live"]
    /\ attempts' = [s \in Scripts |-> 0]
    /\ missed' = [s \in Scripts |-> FALSE]
    /\ lost' = [s \in Scripts |-> FALSE]
    /\ baseline' = [s \in Scripts |-> TRUE]
    /\ reading' = [s \in Scripts |-> FALSE]
    /\ UNCHANGED <<snapSpent, stale, escalated, torn, faults, events>>

Terminal == UNCHANGED vars
Next == \/ \E s \in Scripts : Fail(s) \/ LoseBaseline(s) \/ Backoff(s) \/ Escalate(s)
                              \/ Reopen(s) \/ ReopenReplays(s) \/ CatchUpRead(s)
                              \/ CatchUpFails(s) \/ StartRead(s) \/ AbsorbSpend(s)
                              \/ FoldRead(s)
        \/ \E s \in Scripts, k \in Kinds : Event(s, k)
        \/ SdkReset \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK == /\ state \in [Scripts -> Phases]
          /\ attempts \in [Scripts -> 0..(MaxAttempts + 1)]
          /\ missed \in [Scripts -> BOOLEAN] /\ lost \in [Scripts -> BOOLEAN]
          /\ baseline \in [Scripts -> BOOLEAN]
          /\ snapSpent \in [Scripts -> BOOLEAN]
          /\ reading \in [Scripts -> BOOLEAN] /\ stale \in [Scripts -> BOOLEAN]
          /\ escalated \in BOOLEAN
          /\ torn \in Nat /\ faults \in 0..MaxFaults /\ events \in 0..MaxEvents
\* A script back on its stream owes nothing from the gap it was away for.
NoMissedEvent == \A s \in Scripts : state[s] = "live" => ~missed[s] /\ ~lost[s]
\* A script that cannot resume is handed to the SDK, never retried in silence.
BoundedIsolatedRetry == \A s \in Scripts : attempts[s] <= MaxAttempts
\* One script's failure detaches no sibling.
NoCollateralTeardown == torn = 0
\* An in-flight read never walks the snapshot back over what the stream already advanced.
NoStaleSnapshot == \A s \in Scripts : ~stale[s]
====
