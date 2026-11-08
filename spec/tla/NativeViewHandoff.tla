---- MODULE NativeViewHandoff ----
EXTENDS Naturals, FiniteSets

\* FinishLock models successful cleanup only. NativeWallet.pause also clears its
\* retained cache on cleanup rejection; that failure policy is outside this model.

CONSTANTS Actors, MaxOwners, MaxGeneration, BreakGeneration, BreakVisibility,
          BreakLock, BreakCandidate, BreakReadiness, BreakDisposal,
          BreakShutdownOwner, BreakRetainedView
VARIABLES visible, locked, secret, generation, issued, ownerGeneration,
          shown, retained, candidate, readOnly, live, retired,
          poolReady, walletReady, callbacks, shutdownOwner, bad

vars == <<visible, locked, secret, generation, issued, ownerGeneration,
          shown, retained, candidate, readOnly, live, retired,
          poolReady, walletReady, callbacks, shutdownOwner, bad>>
Owners == 1..MaxOwners
Failures == {"generation", "visibility", "lock", "candidate", "readiness", "shutdown"}

Init ==
    /\ visible = TRUE /\ locked = FALSE /\ secret = TRUE
    /\ generation = 1 /\ issued = 1
    /\ ownerGeneration = [o \in Owners |-> 1]
    /\ shown = 1 /\ retained = 1 /\ candidate = 0 /\ readOnly = FALSE
    /\ live = {1} /\ retired = {} /\ poolReady = {1} /\ walletReady = {1}
    /\ callbacks = [a \in Actors |-> 0] /\ shutdownOwner = 1 /\ bad = {}

Hide ==
    /\ visible /\ visible' = FALSE /\ readOnly' = TRUE
    /\ UNCHANGED <<locked, secret, generation, issued, ownerGeneration,
                   shown, retained, candidate, live, retired, poolReady,
                   walletReady, callbacks, shutdownOwner, bad>>

Foreground ==
    /\ ~visible /\ visible' = TRUE
    /\ UNCHANGED <<locked, secret, generation, issued, ownerGeneration,
                   shown, retained, candidate, readOnly, live, retired,
                   poolReady, walletReady, callbacks, shutdownOwner, bad>>

LockIntent ==
    /\ ~locked /\ locked' = TRUE /\ readOnly' = TRUE
    /\ shown' = 0 /\ retained' = 0 /\ candidate' = 0
    /\ retired' = retired \cup live
    /\ UNCHANGED <<visible, secret, generation, issued, ownerGeneration,
                   live, poolReady,
                   walletReady, callbacks, shutdownOwner, bad>>

Retire ==
    /\ candidate # 0 \/ ~readOnly \/ ~(live \subseteq retired)
    /\ candidate' = 0 /\ readOnly' = TRUE /\ retired' = retired \cup live
    /\ shown' = IF BreakRetainedView THEN 0 ELSE shown
    /\ UNCHANGED <<visible, locked, secret, generation, issued,
                   ownerGeneration, retained, live, poolReady, walletReady,
                   callbacks, shutdownOwner, bad>>

Dispose(o) ==
    /\ o \in live \cap retired /\ live' = live \ {o}
    /\ UNCHANGED <<visible, locked, secret, generation, issued,
                   ownerGeneration, shown, retained, candidate, readOnly,
                   retired, poolReady, walletReady, callbacks, shutdownOwner, bad>>

StartNative ==
    /\ visible /\ ~locked /\ generation < MaxGeneration
    /\ generation' = generation + 1 /\ readOnly' = TRUE
    /\ UNCHANGED <<visible, locked, secret, issued, ownerGeneration,
                   shown, retained, candidate, live, retired, poolReady,
                   walletReady, callbacks, shutdownOwner, bad>>

BeginCandidate ==
    /\ visible /\ (~locked \/ BreakLock) /\ secret /\ readOnly /\ candidate = 0
    /\ generation > ownerGeneration[issued]
    /\ issued < MaxOwners /\ (live = {} \/ BreakDisposal)
    /\ issued' = issued + 1 /\ candidate' = issued + 1
    /\ ownerGeneration' = [ownerGeneration EXCEPT ![issued + 1] = generation]
    /\ live' = live \cup {issued + 1} /\ shutdownOwner' = issued + 1
    /\ UNCHANGED <<visible, locked, secret, generation, shown, retained,
                   readOnly, retired, poolReady, walletReady, callbacks, bad>>

PoolReady(o) ==
    /\ o \in 2..issued /\ o \notin poolReady /\ poolReady' = poolReady \cup {o}
    /\ UNCHANGED <<visible, locked, secret, generation, issued,
                   ownerGeneration, shown, retained, candidate, readOnly,
                   live, retired, walletReady, callbacks, shutdownOwner, bad>>

WalletReady(o) ==
    /\ o \in 2..issued /\ o \notin walletReady /\ walletReady' = walletReady \cup {o}
    /\ UNCHANGED <<visible, locked, secret, generation, issued,
                   ownerGeneration, shown, retained, candidate, readOnly,
                   live, retired, poolReady, callbacks, shutdownOwner, bad>>

CaptureReady(a, o) ==
    /\ callbacks[a] = 0 /\ o \in 2..issued
    /\ callbacks' = [callbacks EXCEPT ![a] = o]
    /\ UNCHANGED <<visible, locked, secret, generation, issued,
                   ownerGeneration, shown, retained, candidate, readOnly,
                   live, retired, poolReady, walletReady, shutdownOwner, bad>>

DeliverReady(a) ==
    LET o == callbacks[a] IN
    /\ o # 0
    /\ (ownerGeneration[o] = generation \/ BreakGeneration)
    /\ (visible \/ BreakVisibility) /\ (~locked \/ BreakLock)
    /\ (o = candidate \/ BreakCandidate)
    /\ (o \in poolReady \cap walletReady \/ BreakReadiness)
    /\ shown' = o /\ retained' = o /\ candidate' = 0 /\ readOnly' = FALSE
    /\ callbacks' = [callbacks EXCEPT ![a] = 0]
    /\ bad' = bad
        \cup (IF ownerGeneration[o] # generation THEN {"generation"} ELSE {})
        \cup (IF ~visible THEN {"visibility"} ELSE {})
        \cup (IF locked THEN {"lock"} ELSE {})
        \cup (IF o # candidate THEN {"candidate"} ELSE {})
        \cup (IF o \notin poolReady \cap walletReady THEN {"readiness"} ELSE {})
    /\ UNCHANGED <<visible, locked, secret, generation, issued,
                   ownerGeneration, live, retired, poolReady, walletReady,
                   shutdownOwner>>

DropReady(a) ==
    /\ callbacks[a] # 0 /\ callbacks' = [callbacks EXCEPT ![a] = 0]
    /\ UNCHANGED <<visible, locked, secret, generation, issued,
                   ownerGeneration, shown, retained, candidate, readOnly,
                   live, retired, poolReady, walletReady, shutdownOwner, bad>>

Unmount(o) ==
    /\ o \in 1..issued /\ o \notin live /\ shutdownOwner # 0
    /\ (shutdownOwner = o \/ BreakShutdownOwner)
    /\ shutdownOwner' = 0
    /\ bad' = bad \cup (IF shutdownOwner # o THEN {"shutdown"} ELSE {})
    /\ UNCHANGED <<visible, locked, secret, generation, issued,
                   ownerGeneration, shown, retained, candidate, readOnly,
                   live, retired, poolReady, walletReady, callbacks>>

FinishLock ==
    /\ locked /\ live = {} /\ candidate = 0 /\ secret
    /\ shown' = 0 /\ retained' = 0 /\ secret' = FALSE /\ shutdownOwner' = 0
    /\ UNCHANGED <<visible, locked, generation, issued, ownerGeneration,
                   candidate, readOnly, live, retired, poolReady,
                   walletReady, callbacks, bad>>

Terminal == UNCHANGED vars
Next == Hide \/ Foreground \/ LockIntent \/ Retire \/ StartNative
        \/ BeginCandidate \/ FinishLock \/ Terminal
        \/ (\E o \in Owners : Dispose(o) \/ PoolReady(o) \/ WalletReady(o) \/ Unmount(o))
        \/ (\E a \in Actors : DeliverReady(a) \/ DropReady(a)
            \/ (\E o \in Owners : CaptureReady(a, o)))
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ visible \in BOOLEAN /\ locked \in BOOLEAN /\ secret \in BOOLEAN
    /\ generation \in 1..MaxGeneration /\ issued \in Owners
    /\ ownerGeneration \in [Owners -> 1..MaxGeneration]
    /\ shown \in 0..issued /\ retained \in 0..issued /\ candidate \in 0..issued
    /\ readOnly \in BOOLEAN /\ live \subseteq 1..issued /\ retired \subseteq 1..issued
    /\ poolReady \subseteq 1..issued /\ walletReady \subseteq 1..issued
    /\ callbacks \in [Actors -> 0..issued] /\ shutdownOwner \in 0..issued
    /\ bad \subseteq Failures
NoStaleGeneration == "generation" \notin bad
NoHiddenActivation == "visibility" \notin bad
NoLockedActivation == "lock" \notin bad
OnlyCurrentCandidate == "candidate" \notin bad
ReadyBeforePromotion == "readiness" \notin bad
DisposeBeforeNewOwner == Cardinality(live) <= 1
ShutdownOwnerPreserved == "shutdown" \notin bad
RetainUntilReady == shown = retained
LockClearsAfterCleanup == ~secret => locked /\ live = {} /\ shown = 0 /\ candidate = 0
====
