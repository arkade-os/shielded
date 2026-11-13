VIOLATED NoCollateralTeardown, 2 states

| # | action | changed |
|---|---|---|
| 1 | Initial | state = (s1 :> "live" @@ s2 :> "live")<br>faults = 0<br>missed = (s1 :> FALSE @@ s2 :> FALSE)<br>attempts = (s1 :> 0 @@ s2 :> 0)<br>torn = 0<br>baseline = (s1 :> TRUE @@ s2 :> TRUE)<br>events = 0<br>escalated = FALSE<br>lost = (s1 :> FALSE @@ s2 :> FALSE) |
| 2 | Fail | state = (s1 :> "broken" @@ s2 :> "live")<br>faults = 1<br>torn = 1 |
