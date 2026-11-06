---- MODULE TorConnect ----
EXTENDS Naturals

CONSTANTS BreakRetryFence, BreakFreshScope
VARIABLES pc, generation, cancelled, scopeOpen, scopeContext,
          attempts, retryContext, retiredRetry, connected, tlsReady, sends

vars == <<pc, generation, cancelled, scopeOpen, scopeContext,
          attempts, retryContext, retiredRetry, connected, tlsReady, sends>>
Active == generation = 1 /\ ~cancelled /\ scopeOpen
Phases == {"start", "firstPending", "firstFailed", "rotated",
           "retryPending", "connected", "tlsPending", "readyToSend",
           "sent", "done", "failed"}

Init == /\ pc = "start" /\ generation = 1
        /\ cancelled = FALSE /\ scopeOpen = TRUE
        /\ scopeContext = 0 /\ attempts = 0 /\ retryContext = 0
        /\ retiredRetry = FALSE /\ connected = FALSE
        /\ tlsReady = FALSE /\ sends = 0

FirstConnect ==
    /\ pc = "start" /\ Active
    /\ pc' = "firstPending" /\ attempts' = 1
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext,
                   retryContext, retiredRetry, connected, tlsReady, sends>>

FirstSuccess ==
    /\ pc = "firstPending"
    /\ pc' = "connected" /\ connected' = TRUE
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext,
                   attempts, retryContext, retiredRetry, tlsReady, sends>>

FirstFailure ==
    /\ pc = "firstPending" /\ pc' = "firstFailed"
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext,
                   attempts, retryContext, retiredRetry, connected,
                   tlsReady, sends>>

OtherRecovery ==
    /\ Active /\ scopeContext = 0
    /\ scopeContext' = 1
    /\ UNCHANGED <<pc, generation, cancelled, scopeOpen, attempts,
                   retryContext, retiredRetry, connected, tlsReady, sends>>

RotateScope ==
    /\ pc = "firstFailed" /\ Active
    /\ pc' = "rotated"
    /\ scopeContext' = IF scopeContext = 0 /\ ~BreakFreshScope
                      THEN 1 ELSE scopeContext
    /\ UNCHANGED <<generation, cancelled, scopeOpen, attempts,
                   retryContext, retiredRetry, connected, tlsReady, sends>>

RetryConnect ==
    /\ pc = "rotated" /\ (BreakRetryFence \/ Active)
    /\ pc' = "retryPending" /\ attempts' = 2
    /\ retryContext' = scopeContext /\ retiredRetry' = ~Active
    /\ UNCHANGED <<generation, cancelled, scopeOpen, connected,
                   tlsReady, sends, scopeContext>>

RetrySuccess ==
    /\ pc = "retryPending"
    /\ pc' = "connected" /\ connected' = TRUE
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext,
                   attempts, retryContext, retiredRetry, tlsReady, sends>>

RetryFailure ==
    /\ pc = "retryPending" /\ pc' = "failed"
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext,
                   attempts, retryContext, retiredRetry, connected,
                   tlsReady, sends>>

StartTLS ==
    /\ pc = "connected" /\ Active /\ pc' = "tlsPending"
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext,
                   attempts, retryContext, retiredRetry, connected,
                   tlsReady, sends>>

TLSResult(ok) ==
    /\ pc = "tlsPending"
    /\ pc' = IF ok THEN "readyToSend" ELSE "failed"
    /\ tlsReady' = ok
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext,
                   attempts, retryContext, retiredRetry, connected, sends>>

SendHTTP ==
    /\ pc = "readyToSend" /\ Active
    /\ pc' = "sent" /\ sends' = sends + 1
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext,
                   attempts, retryContext, retiredRetry, connected, tlsReady>>

HTTPResult(ok) ==
    /\ pc = "sent" /\ pc' = IF ok THEN "done" ELSE "failed"
    /\ UNCHANGED <<generation, cancelled, scopeOpen, scopeContext,
                   attempts, retryContext, retiredRetry, connected,
                   tlsReady, sends>>

Pause ==
    /\ generation = 1 /\ generation' = 2
    /\ UNCHANGED <<pc, cancelled, scopeOpen, scopeContext, attempts,
                   retryContext, retiredRetry, connected, tlsReady, sends>>

Cancel ==
    /\ ~cancelled /\ cancelled' = TRUE
    /\ UNCHANGED <<pc, generation, scopeOpen, scopeContext, attempts,
                   retryContext, retiredRetry, connected, tlsReady, sends>>

CloseScope ==
    /\ scopeOpen /\ scopeOpen' = FALSE
    /\ UNCHANGED <<pc, generation, cancelled, scopeContext, attempts,
                   retryContext, retiredRetry, connected, tlsReady, sends>>

Terminal == UNCHANGED vars
Next == FirstConnect \/ FirstSuccess \/ FirstFailure \/ OtherRecovery
        \/ RotateScope \/ RetryConnect \/ RetrySuccess \/ RetryFailure
        \/ StartTLS \/ TLSResult(TRUE) \/ TLSResult(FALSE)
        \/ SendHTTP \/ HTTPResult(TRUE) \/ HTTPResult(FALSE)
        \/ Pause \/ Cancel \/ CloseScope \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK == /\ pc \in Phases /\ generation \in {1, 2}
          /\ scopeContext \in {0, 1} /\ attempts \in 0..2
          /\ retryContext \in {0, 1} /\ sends \in Nat
          /\ \A b \in {cancelled, scopeOpen, retiredRetry, connected,
                        tlsReady} : b \in BOOLEAN
NoRetiredReconnect == ~retiredRetry
RetryUsesFreshScope == attempts = 2 => retryContext = 1
NoRequestBeforeConnected == sends > 0 => connected /\ tlsReady
AtMostOneHTTPSend == sends <= 1
====
