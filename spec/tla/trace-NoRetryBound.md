VIOLATED BoundedIsolatedRetry, 7 states

| # | action | changed |
|---|---|---|
| 1 | Initial | state = (s1 :> "live" @@ s2 :> "live")<br>faults = 0<br>missed = (s1 :> FALSE @@ s2 :> FALSE)<br>attempts = (s1 :> 0 @@ s2 :> 0)<br>torn = 0<br>events = 0<br>escalated = FALSE<br>lost = (s1 :> FALSE @@ s2 :> FALSE) |
| 2 | Fail | state = (s1 :> "broken" @@ s2 :> "live")<br>faults = 1 |
| 3 | Backoff | state = (s1 :> "backoff" @@ s2 :> "live")<br>attempts = (s1 :> 1 @@ s2 :> 0) |
| 4 | CatchUpFails | state = (s1 :> "broken" @@ s2 :> "live")<br>faults = 2 |
| 5 | Backoff | state = (s1 :> "backoff" @@ s2 :> "live")<br>attempts = (s1 :> 2 @@ s2 :> 0) |
| 6 | CatchUpFails | state = (s1 :> "broken" @@ s2 :> "live")<br>faults = 3 |
| 7 | Backoff | state = (s1 :> "backoff" @@ s2 :> "live")<br>attempts = (s1 :> 3 @@ s2 :> 0) |
