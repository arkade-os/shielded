---- MODULE TorRefusal ----
EXTENDS Naturals

CONSTANTS BreakRotateBound, BreakRotateFence, BreakDirectGuard,
          BreakOwnRecovery, TorMode
VARIABLES pc, generation, cancelled, scopeOpen, scopeContext, usedContext,
          refusals, rotations, replacements, intervals, cooling,
          retiredRotate, retainedRefused

vars == <<pc, generation, cancelled, scopeOpen, scopeContext, usedContext,
          refusals, rotations, replacements, intervals, cooling,
          retiredRotate, retainedRefused>>
MaxRefusals == 2
Active == generation = 1 /\ ~cancelled /\ scopeOpen
Phases == {"idle", "sent", "refused", "done"}
\* A refusal belongs to the context that carried it. Fencing on the context the lease
\* registered with instead keeps a client a connect retry had already replaced.
Fenced == IF BreakOwnRecovery THEN usedContext = 0 ELSE usedContext = scopeContext
Allowed == /\ (BreakRotateFence \/ Active)
           /\ (BreakRotateBound \/ ~cooling)
           /\ (BreakDirectGuard \/ TorMode)
           /\ Fenced
Owed == Active /\ ~cooling /\ TorMode /\ usedContext = scopeContext

Init == /\ pc = "idle" /\ generation = 1
        /\ cancelled = FALSE /\ scopeOpen = TRUE
        /\ scopeContext = 0 /\ usedContext = 0
        /\ refusals = 0 /\ rotations = 0 /\ replacements = 0
        /\ intervals = 0 /\ cooling = FALSE
        /\ retiredRotate = FALSE /\ retainedRefused = FALSE

Recover ==
    /\ pc = "idle" /\ Active /\ TorMode /\ replacements < MaxRefusals
    /\ scopeContext' = scopeContext + 1 /\ replacements' = replacements + 1
    /\ UNCHANGED <<pc, generation, cancelled, scopeOpen, usedContext, refusals,
                   rotations, intervals, cooling, retiredRotate,
                   retainedRefused>>

OtherRecovery ==
    /\ pc \in {"sent", "refused"} /\ TorMode /\ replacements < MaxRefusals
    /\ scopeContext' = scopeContext + 1 /\ replacements' = replacements + 1
    /\ UNCHANGED <<pc, generation, cancelled, scopeOpen, usedContext, refusals,
                   rotations, intervals, cooling, retiredRotate,
                   retainedRefused>>

Send ==
    /\ pc = "idle" /\ Active /\ refusals < MaxRefusals
    /\ pc' = "sent" /\ usedContext' = scopeContext
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext, refusals,
                   rotations, replacements, intervals, cooling, retiredRotate,
                   retainedRefused>>

Refused ==
    /\ pc = "sent" /\ pc' = "refused" /\ refusals' = refusals + 1
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext, usedContext,
                   rotations, replacements, intervals, cooling, retiredRotate,
                   retainedRefused>>

Accepted ==
    /\ pc = "sent" /\ pc' = "done"
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext, usedContext,
                   refusals, rotations, replacements, intervals, cooling,
                   retiredRotate, retainedRefused>>

Retire ==
    /\ pc = "refused" /\ Allowed
    /\ pc' = "idle" /\ rotations' = rotations + 1
    /\ scopeContext' = scopeContext + 1 /\ cooling' = TRUE
    /\ retiredRotate' = (retiredRotate \/ ~Active)
    /\ UNCHANGED <<generation, cancelled, scopeOpen, usedContext, refusals,
                   replacements, intervals, retainedRefused>>

Decline ==
    /\ pc = "refused" /\ ~Allowed
    /\ pc' = "idle" /\ retainedRefused' = (retainedRefused \/ Owed)
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext, usedContext,
                   refusals, rotations, replacements, intervals, cooling,
                   retiredRotate>>

IntervalElapses ==
    /\ cooling /\ intervals < MaxRefusals
    /\ cooling' = FALSE /\ intervals' = intervals + 1
    /\ UNCHANGED <<pc, generation, cancelled, scopeOpen, scopeContext,
                   usedContext, refusals, rotations, replacements,
                   retiredRotate, retainedRefused>>

Pause ==
    /\ generation = 1 /\ generation' = 2
    /\ UNCHANGED <<pc, cancelled, scopeOpen, scopeContext, usedContext,
                   refusals, rotations, replacements, intervals, cooling,
                   retiredRotate, retainedRefused>>

Cancel ==
    /\ ~cancelled /\ cancelled' = TRUE
    /\ UNCHANGED <<pc, generation, scopeOpen, scopeContext, usedContext,
                   refusals, rotations, replacements, intervals, cooling,
                   retiredRotate, retainedRefused>>

CloseScope ==
    /\ scopeOpen /\ scopeOpen' = FALSE
    /\ UNCHANGED <<pc, generation, cancelled, scopeContext, usedContext,
                   refusals, rotations, replacements, intervals, cooling,
                   retiredRotate, retainedRefused>>

Terminal == UNCHANGED vars
Next == Send \/ Refused \/ Accepted \/ Retire \/ Decline \/ Recover
        \/ OtherRecovery \/ IntervalElapses \/ Pause \/ Cancel \/ CloseScope
        \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK == /\ pc \in Phases /\ generation \in {1, 2}
          /\ refusals \in 0..MaxRefusals /\ rotations \in 0..MaxRefusals
          /\ replacements \in 0..MaxRefusals /\ intervals \in 0..MaxRefusals
          /\ scopeContext \in 0..(2 * MaxRefusals)
          /\ usedContext \in 0..(2 * MaxRefusals)
          /\ \A b \in {cancelled, scopeOpen, cooling, retiredRotate,
                       retainedRefused} : b \in BOOLEAN
RotationsBoundedByInterval == rotations <= intervals + 1
NoRetiredRotation == ~retiredRotate
NoDirectRotation == TorMode \/ rotations = 0
ContextTracksReplacement == scopeContext = rotations + replacements
NoRetainedRefusedCircuit == ~retainedRefused
====
