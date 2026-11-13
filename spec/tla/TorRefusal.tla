---- MODULE TorRefusal ----
EXTENDS Naturals

CONSTANTS BreakRotateBound, BreakRotateFence, BreakDirectGuard, TorMode
VARIABLES pc, generation, cancelled, scopeOpen, scopeContext,
          refusals, rotations, intervals, cooling, retiredRotate

vars == <<pc, generation, cancelled, scopeOpen, scopeContext,
          refusals, rotations, intervals, cooling, retiredRotate>>
MaxRefusals == 3
Active == generation = 1 /\ ~cancelled /\ scopeOpen
Phases == {"idle", "sent", "refused", "done"}

Init == /\ pc = "idle" /\ generation = 1
        /\ cancelled = FALSE /\ scopeOpen = TRUE
        /\ scopeContext = 0 /\ refusals = 0 /\ rotations = 0
        /\ intervals = 0 /\ cooling = FALSE /\ retiredRotate = FALSE

Send ==
    /\ pc = "idle" /\ Active /\ refusals < MaxRefusals
    /\ pc' = "sent"
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext, refusals,
                   rotations, intervals, cooling, retiredRotate>>

Refused ==
    /\ pc = "sent" /\ pc' = "refused" /\ refusals' = refusals + 1
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext, rotations,
                   intervals, cooling, retiredRotate>>

Accepted ==
    /\ pc = "sent" /\ pc' = "done"
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext, refusals,
                   rotations, intervals, cooling, retiredRotate>>

Retire ==
    /\ pc = "refused"
    /\ (BreakRotateFence \/ Active)
    /\ (BreakRotateBound \/ ~cooling)
    /\ (BreakDirectGuard \/ TorMode)
    /\ pc' = "idle" /\ rotations' = rotations + 1
    /\ scopeContext' = scopeContext + 1 /\ cooling' = TRUE
    /\ retiredRotate' = (retiredRotate \/ ~Active)
    /\ UNCHANGED <<generation, cancelled, scopeOpen, refusals, intervals>>

Decline ==
    /\ pc = "refused" /\ pc' = "idle"
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext, refusals,
                   rotations, intervals, cooling, retiredRotate>>

IntervalElapses ==
    /\ cooling /\ intervals < MaxRefusals
    /\ cooling' = FALSE /\ intervals' = intervals + 1
    /\ UNCHANGED <<pc, generation, cancelled, scopeOpen, scopeContext,
                   refusals, rotations, retiredRotate>>

Pause ==
    /\ generation = 1 /\ generation' = 2
    /\ UNCHANGED <<pc, cancelled, scopeOpen, scopeContext, refusals,
                   rotations, intervals, cooling, retiredRotate>>

Cancel ==
    /\ ~cancelled /\ cancelled' = TRUE
    /\ UNCHANGED <<pc, generation, scopeOpen, scopeContext, refusals,
                   rotations, intervals, cooling, retiredRotate>>

CloseScope ==
    /\ scopeOpen /\ scopeOpen' = FALSE
    /\ UNCHANGED <<pc, generation, cancelled, scopeContext, refusals,
                   rotations, intervals, cooling, retiredRotate>>

Terminal == UNCHANGED vars
Next == Send \/ Refused \/ Accepted \/ Retire \/ Decline
        \/ IntervalElapses \/ Pause \/ Cancel \/ CloseScope \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK == /\ pc \in Phases /\ generation \in {1, 2}
          /\ refusals \in 0..MaxRefusals /\ rotations \in 0..MaxRefusals
          /\ intervals \in 0..MaxRefusals /\ scopeContext \in 0..MaxRefusals
          /\ \A b \in {cancelled, scopeOpen, cooling, retiredRotate} :
                b \in BOOLEAN
RotationsBoundedByInterval == rotations <= intervals + 1
NoRetiredRotation == ~retiredRotate
NoDirectRotation == TorMode \/ rotations = 0
FreshContextPerRotation == scopeContext = rotations
====
