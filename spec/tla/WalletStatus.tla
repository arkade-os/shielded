---- MODULE WalletStatus ----
EXTENDS Naturals

CONSTANTS MaxClock, BreakIndependence, BreakSingleFlight,
          BreakPublishFence, BreakTimerFence
VARIABLES clock, stopped, maintenance, heartbeat, due, reads,
          statusAt, lateStatus, lateTimer

vars == <<clock, stopped, maintenance, heartbeat, due, reads,
          statusAt, lateStatus, lateTimer>>

Init == /\ clock = 0 /\ stopped = FALSE
        /\ maintenance = "new" /\ heartbeat = "waiting" /\ due = 0
        /\ reads = 0 /\ statusAt = 0
        /\ lateStatus = FALSE /\ lateTimer = FALSE

StartMaintenance ==
    /\ ~stopped /\ maintenance = "new"
    /\ maintenance' = "awaitStatus"
    /\ reads' = IF reads = 0 \/ BreakSingleFlight THEN reads + 1 ELSE reads
    /\ UNCHANGED <<clock, stopped, heartbeat, due, statusAt,
                   lateStatus, lateTimer>>

HeartbeatDue == heartbeat = "waiting" /\ clock >= due
HeartbeatRunnable == HeartbeatDue /\ (~BreakIndependence \/ maintenance # "sync")

StartHeartbeat ==
    /\ ~stopped /\ HeartbeatRunnable
    /\ heartbeat' = "awaitStatus"
    /\ reads' = IF reads = 0 \/ BreakSingleFlight THEN reads + 1 ELSE reads
    /\ UNCHANGED <<clock, stopped, maintenance, due, statusAt,
                   lateStatus, lateTimer>>

StatusResult ==
    /\ reads > 0 /\ reads' = reads - 1
    /\ statusAt' = IF ~stopped \/ BreakPublishFence THEN clock ELSE statusAt
    /\ lateStatus' = (lateStatus \/ (stopped /\ BreakPublishFence))
    /\ maintenance' = IF maintenance = "awaitStatus"
                      THEN IF stopped THEN "done" ELSE "sync" ELSE maintenance
    /\ heartbeat' = IF heartbeat = "awaitStatus" THEN "arm" ELSE heartbeat
    /\ UNCHANGED <<clock, stopped, due, lateTimer>>

ArmHeartbeat ==
    /\ heartbeat = "arm" /\ (~stopped \/ BreakTimerFence)
    /\ heartbeat' = "waiting" /\ due' = clock + 1
    /\ lateTimer' = (lateTimer \/ stopped)
    /\ UNCHANGED <<clock, stopped, maintenance, reads, statusAt, lateStatus>>

PrivateComplete ==
    /\ maintenance = "sync" /\ maintenance' = "done"
    /\ UNCHANGED <<clock, stopped, heartbeat, due, reads,
                   statusAt, lateStatus, lateTimer>>

AdvanceClock ==
    /\ clock < MaxClock
    /\ stopped \/ (reads = 0 /\ ~HeartbeatRunnable /\ heartbeat # "arm")
    /\ clock' = clock + 1
    /\ UNCHANGED <<stopped, maintenance, heartbeat, due, reads,
                   statusAt, lateStatus, lateTimer>>

Stop ==
    /\ ~stopped /\ stopped' = TRUE
    /\ heartbeat' = IF heartbeat = "waiting" THEN "stopped" ELSE heartbeat
    /\ UNCHANGED <<clock, maintenance, due, reads, statusAt,
                   lateStatus, lateTimer>>

Terminal == UNCHANGED vars
Next == StartMaintenance \/ StartHeartbeat \/ StatusResult \/ ArmHeartbeat
        \/ PrivateComplete \/ AdvanceClock \/ Stop \/ Terminal
Spec == Init /\ [][Next]_vars
        /\ WF_vars(StartMaintenance) /\ WF_vars(StartHeartbeat)
        /\ WF_vars(StatusResult) /\ WF_vars(ArmHeartbeat)
        /\ WF_vars(AdvanceClock)

TypeOK == /\ clock \in 0..MaxClock /\ statusAt \in 0..MaxClock
          /\ due \in 0..(MaxClock + 1) /\ reads \in 0..2
          /\ maintenance \in {"new", "awaitStatus", "sync", "done"}
          /\ heartbeat \in {"waiting", "awaitStatus", "arm", "stopped"}
          /\ stopped \in BOOLEAN /\ lateStatus \in BOOLEAN /\ lateTimer \in BOOLEAN
OneStatusRead == reads <= 1
NoStatusAfterStop == ~lateStatus
NoTimerAfterStop == ~lateTimer
FreshWhileSyncing == ~stopped /\ maintenance = "sync" => clock < statusAt + 2
PulseProgress == \A t \in 0..MaxClock :
    (~stopped /\ maintenance = "sync" /\ HeartbeatDue /\ clock = t)
    ~> (stopped \/ statusAt >= t)
====
