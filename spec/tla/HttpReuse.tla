---- MODULE HttpReuse ----
EXTENDS Naturals, FiniteSets

\* Register/Checkout/Return: session.rs Lease.take_http/return_http
\* Expire: session.rs Inner.expire_http; Dispatch/Response: wire.rs
\* Transport retirement/drain: session.rs Session.invalidate/StartWork
CONSTANTS Workers, Scopes, Origins, MaxIdle, BreakCheckoutFence,
          BreakScope, BreakOrigin, BreakCheckoutContext, BreakExclusive,
          BreakReturnFence, BreakReturnContext, BreakComplete, BreakBound,
          BreakExpiryFence, BreakResend, BreakDrain
VARIABLES generation, phase, scopeOpen, scopeContext, pool, poolToken,
          connections, requests, expiries, closing, bad
vars == <<generation, phase, scopeOpen, scopeContext, pool, poolToken,
          connections, requests, expiries, closing, bad>>
PCs == {"idle", "registered", "connecting", "connectFailed", "recovering",
        "ready", "sent", "bodyDone", "failed", "done", "closed"}
None == 0
InitialRequest == [pc |-> "idle", scope |-> None, origin |-> None,
                   gen |-> 0, ctx |-> 0, held |-> None, sends |-> 0,
                   cancelled |-> FALSE, reused |-> FALSE]
InitialConnection == [scope |-> None, origin |-> None, gen |-> 0,
                      ctx |-> 0, complete |-> FALSE, live |-> FALSE]
InitialExpiry == [armed |-> FALSE, scope |-> None, gen |-> 0]
R(w) == requests[w]
C(c) == connections[c]
Active(w) == phase = "ready" /\ R(w).gen = generation
             /\ scopeOpen[R(w).scope] /\ ~R(w).cancelled
CurrentContext(w) == R(w).ctx = scopeContext[R(w).scope]
Cached == {pool[s] : s \in {t \in Scopes : pool[t] # None}}
Live == {c \in Workers : C(c).live}
HasBody(w) == R(w).pc = "bodyDone" /\ C(R(w).held).complete
NoBody(w) == R(w).pc = "sent" /\ ~C(R(w).held).complete

Init ==
    /\ generation = 1 /\ phase = "ready"
    /\ scopeOpen = [s \in Scopes |-> TRUE]
    /\ scopeContext = [s \in Scopes |-> 0]
    /\ pool = [s \in Scopes |-> None]
    /\ poolToken = [s \in Scopes |-> None]
    /\ connections = [c \in Workers |-> InitialConnection]
    /\ requests = [w \in Workers |-> InitialRequest]
    /\ expiries = [w \in Workers |-> InitialExpiry]
    /\ closing = {} /\ bad = {}

Register(w,s,o) ==
    /\ R(w).pc = "idle" /\ phase = "ready" /\ scopeOpen[s]
    /\ requests' = [requests EXCEPT ![w] =
          [@ EXCEPT !.pc = "registered", !.scope = s, !.origin = o,
                    !.gen = generation, !.ctx = scopeContext[s]]]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, connections, expiries, closing, bad>>

Checkout(w,s) ==
    /\ R(w).pc = "registered" /\ pool[s] # None
    /\ (BreakCheckoutFence \/ Active(w))
    /\ (BreakScope \/ s = R(w).scope)
    /\ (BreakOrigin \/ C(pool[s]).origin = R(w).origin)
    /\ (BreakCheckoutContext \/ (CurrentContext(w) /\ C(pool[s]).ctx = R(w).ctx))
    /\ requests' = [requests EXCEPT ![w] =
          [@ EXCEPT !.pc = "ready", !.held = pool[s], !.reused = TRUE]]
    /\ pool' = IF BreakExclusive THEN pool ELSE [pool EXCEPT ![s] = None]
    /\ poolToken' = IF BreakExclusive THEN poolToken ELSE [poolToken EXCEPT ![s] = None]
    /\ bad' = bad \cup
         (IF ~Active(w) THEN {"checkoutFence"} ELSE {}) \cup
         (IF s # R(w).scope THEN {"scope"} ELSE {}) \cup
         (IF C(pool[s]).origin # R(w).origin THEN {"origin"} ELSE {}) \cup
         (IF ~CurrentContext(w) \/ C(pool[s]).ctx # R(w).ctx
          THEN {"checkoutContext"} ELSE {})
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, connections,
                   expiries, closing>>

Open(w) ==
    /\ R(w).pc = "registered" /\ Active(w)
    /\ requests' = [requests EXCEPT ![w] =
          [@ EXCEPT !.pc = "connecting", !.held = w]]
    /\ connections' = [connections EXCEPT ![w] =
          [scope |-> R(w).scope, origin |-> R(w).origin,
           gen |-> R(w).gen, ctx |-> R(w).ctx,
           complete |-> FALSE, live |-> TRUE]]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, expiries, closing, bad>>

ConnectResult(w,ok) ==
    /\ R(w).pc \in {"connecting","recovering"}
    /\ requests' = [requests EXCEPT ![w].pc =
          IF ok THEN "ready"
          ELSE IF R(w).pc = "connecting" THEN "connectFailed" ELSE "failed"]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, connections, expiries, closing, bad>>

Recover(w) ==
    /\ R(w).pc = "connectFailed" /\ Active(w)
    /\ scopeContext[R(w).scope] = 0 \/ ~CurrentContext(w)
    /\ LET s == R(w).scope IN
       /\ scopeContext' = [scopeContext EXCEPT ![s] = 1]
       /\ connections' = [connections EXCEPT ![R(w).held].ctx = 1]
       /\ closing' = closing \cup (IF pool[s] = None THEN {} ELSE {pool[s]})
       /\ pool' = [pool EXCEPT ![s] = None]
       /\ poolToken' = [poolToken EXCEPT ![s] = None]
    /\ requests' = [requests EXCEPT ![w].pc = "recovering"]
    /\ UNCHANGED <<generation, phase, scopeOpen, expiries, bad>>

ReplaceClosed(w) ==
    /\ R(w).pc = "ready" /\ R(w).reused /\ R(w).sends = 0 /\ Active(w)
    /\ closing' = closing \cup {R(w).held}
    /\ requests' = [requests EXCEPT ![w] =
          [@ EXCEPT !.pc = "connecting", !.held = w, !.reused = FALSE]]
    /\ connections' = [connections EXCEPT ![w] =
          [scope |-> R(w).scope, origin |-> R(w).origin,
           gen |-> R(w).gen, ctx |-> R(w).ctx,
           complete |-> FALSE, live |-> TRUE]]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, expiries, bad>>

Dispatch(w) ==
    /\ R(w).pc = "ready" /\ Active(w) /\ R(w).sends < 2
    /\ requests' = [requests EXCEPT ![w] =
          [@ EXCEPT !.pc = "sent", !.sends = @ + 1]]
    /\ connections' = [connections EXCEPT ![R(w).held].complete = FALSE]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, expiries, closing, bad>>

Response(w,ok) ==
    /\ R(w).pc = "sent"
    /\ requests' = [requests EXCEPT ![w].pc = IF ok THEN "bodyDone" ELSE "failed"]
    /\ connections' = [connections EXCEPT ![R(w).held].complete = ok]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, expiries, closing, bad>>

Resend(w) ==
    /\ BreakResend /\ R(w).pc = "failed" /\ R(w).held # None
    /\ R(w).sends = 1 /\ Active(w)
    /\ requests' = [requests EXCEPT ![w].pc = "ready"]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, connections, expiries, closing, bad>>

Return(w) ==
    /\ R(w).held # None
    /\ (HasBody(w) \/ (BreakComplete /\ NoBody(w)))
    /\ (BreakReturnFence \/ Active(w))
    /\ (BreakReturnContext \/
         (CurrentContext(w) /\ C(R(w).held).ctx = scopeContext[R(w).scope]))
    /\ LET s == R(w).scope IN
       /\ (BreakBound \/ pool[s] # None \/ Cardinality(Cached) < MaxIdle)
       /\ closing' = closing \cup (IF pool[s] = None THEN {} ELSE {pool[s]})
       /\ pool' = [pool EXCEPT ![s] = R(w).held]
       /\ poolToken' = [poolToken EXCEPT ![s] = w]
    /\ requests' = [requests EXCEPT ![w] =
          [@ EXCEPT !.pc = "done", !.held = None]]
    /\ expiries' = [expiries EXCEPT ![w] =
          [armed |-> TRUE, scope |-> R(w).scope, gen |-> R(w).gen]]
    /\ bad' = bad \cup
         (IF ~Active(w) THEN {"returnFence"} ELSE {}) \cup
         (IF ~CurrentContext(w) \/ C(R(w).held).ctx # scopeContext[R(w).scope]
          THEN {"returnContext"} ELSE {})
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, connections>>

Cancel(w) ==
    /\ R(w).pc \notin {"idle","done","closed"} /\ ~R(w).cancelled
    /\ requests' = [requests EXCEPT ![w].cancelled = TRUE]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, connections, expiries, closing, bad>>

Fail(w) ==
    /\ R(w).pc \in {"registered","connecting","connectFailed","recovering","ready"}
    /\ requests' = [requests EXCEPT ![w].pc = "failed"]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, connections, expiries, closing, bad>>

Drop(w) ==
    /\ R(w).pc \notin {"idle","done","closed"}
    /\ closing' = closing \cup (IF R(w).held = None THEN {} ELSE {R(w).held})
    /\ requests' = [requests EXCEPT ![w] =
          [@ EXCEPT !.pc = "closed", !.held = None]]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, connections, expiries, bad>>

Evict(s) ==
    /\ pool[s] # None
    /\ closing' = closing \cup {pool[s]}
    /\ pool' = [pool EXCEPT ![s] = None]
    /\ poolToken' = [poolToken EXCEPT ![s] = None]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, connections,
                   requests, expiries, bad>>

Expire(w) ==
    /\ expiries[w].armed
    /\ LET s == expiries[w].scope
           removes == pool[s] # None /\
                      (BreakExpiryFence \/
                       (generation = expiries[w].gen /\ poolToken[s] = w))
       IN /\ pool' = IF removes THEN [pool EXCEPT ![s] = None] ELSE pool
          /\ poolToken' = IF removes THEN [poolToken EXCEPT ![s] = None] ELSE poolToken
          /\ closing' = closing \cup (IF removes THEN {pool[s]} ELSE {})
          /\ bad' = bad \cup
              (IF removes /\ (generation # expiries[w].gen \/ poolToken[s] # w)
               THEN {"expiry"} ELSE {})
    /\ expiries' = [expiries EXCEPT ![w].armed = FALSE]
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, connections, requests>>

Rotate(s) ==
    /\ phase = "ready" /\ scopeOpen[s] /\ scopeContext[s] = 0
    /\ scopeContext' = [scopeContext EXCEPT ![s] = 1]
    /\ closing' = closing \cup (IF pool[s] = None THEN {} ELSE {pool[s]})
    /\ pool' = [pool EXCEPT ![s] = None]
    /\ poolToken' = [poolToken EXCEPT ![s] = None]
    /\ UNCHANGED <<generation, phase, scopeOpen, connections, requests, expiries, bad>>

CloseScope(s) ==
    /\ scopeOpen[s]
    /\ scopeOpen' = [scopeOpen EXCEPT ![s] = FALSE]
    /\ closing' = closing \cup (IF pool[s] = None THEN {} ELSE {pool[s]})
    /\ pool' = [pool EXCEPT ![s] = None]
    /\ poolToken' = [poolToken EXCEPT ![s] = None]
    /\ UNCHANGED <<generation, phase, scopeContext, connections, requests, expiries, bad>>

Pause ==
    /\ generation = 1 /\ phase = "ready"
    /\ generation' = 2 /\ phase' = "retiring"
    /\ closing' = closing \cup Cached
    /\ pool' = [s \in Scopes |-> None]
    /\ poolToken' = [s \in Scopes |-> None]
    /\ scopeOpen' = [s \in Scopes |-> FALSE]
    /\ UNCHANGED <<scopeContext, connections, requests, expiries, bad>>

Drain(c) ==
    /\ c \in closing
    /\ connections' = [connections EXCEPT ![c].live = FALSE]
    /\ closing' = closing \ {c}
    /\ UNCHANGED <<generation, phase, scopeOpen, scopeContext, pool,
                   poolToken, requests, expiries, bad>>

Resume ==
    /\ phase = "retiring" /\ (BreakDrain \/ Live = {})
    /\ phase' = "ready"
    /\ scopeOpen' = [s \in Scopes |-> TRUE]
    /\ UNCHANGED <<generation, scopeContext, pool, poolToken, connections,
                   requests, expiries, closing, bad>>

Next ==
    \/ \E w \in Workers, s \in Scopes, o \in Origins : Register(w,s,o)
    \/ \E w \in Workers, s \in Scopes : Checkout(w,s)
    \/ \E w \in Workers : Open(w) \/ ConnectResult(w,TRUE) \/ ConnectResult(w,FALSE)
                         \/ Recover(w) \/ ReplaceClosed(w) \/ Dispatch(w)
                         \/ Response(w,TRUE) \/ Response(w,FALSE) \/ Resend(w)
                         \/ Return(w) \/ Cancel(w) \/ Fail(w) \/ Drop(w) \/ Expire(w)
    \/ \E s \in Scopes : Evict(s) \/ Rotate(s) \/ CloseScope(s)
    \/ \E c \in Workers : Drain(c)
    \/ Pause \/ Resume \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ generation \in {1,2} /\ phase \in {"ready","retiring"}
    /\ scopeOpen \in [Scopes -> BOOLEAN] /\ scopeContext \in [Scopes -> {0,1}]
    /\ pool \in [Scopes -> Workers \cup {None}]
    /\ poolToken \in [Scopes -> Workers \cup {None}]
    /\ DOMAIN requests = Workers /\ DOMAIN connections = Workers
    /\ DOMAIN expiries = Workers /\ closing \subseteq Workers
    /\ \A w \in Workers :
         /\ R(w).pc \in PCs /\ R(w).held \in Workers \cup {None}
         /\ R(w).sends \in 0..2 /\ R(w).cancelled \in BOOLEAN
         /\ C(w).live \in BOOLEAN /\ C(w).complete \in BOOLEAN
NoRetiredCheckout == "checkoutFence" \notin bad
NoCrossScopeUse == "scope" \notin bad
NoCrossOriginUse == "origin" \notin bad
NoRetiredContextCheckout == "checkoutContext" \notin bad
ExclusiveOwnership ==
    \A c \in Workers :
      Cardinality({w \in Workers : R(w).held = c}) +
      Cardinality({s \in Scopes : pool[s] = c}) <= 1
NoRetiredReturn == "returnFence" \notin bad
NoRetiredContextReturn == "returnContext" \notin bad
OnlyCompleteBodiesCached == \A c \in Cached : C(c).complete
BoundedIdle == Cardinality(Cached) <= MaxIdle
NoStaleExpiry == "expiry" \notin bad
AtMostOneSend == \A w \in Workers : R(w).sends <= 1
DrainBeforeResume == phase = "ready" => \A c \in Live : C(c).gen = generation
====
