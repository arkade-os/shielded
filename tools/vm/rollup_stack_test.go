package main

import (
	"strings"
	"testing"
)

func TestRollupStackRejectsBranchesThatDisagree(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("unbalanced branches were accepted")
		}
	}()
	s := newRollupStack([]string{"flag"})
	s.ifElse(func() { s.small(1, "x") }, nil)
}

func TestRollupStackTracksPickAndRollDepths(t *testing.T) {
	s := newRollupStack([]string{"a", "b", "c"})
	s.pick("a", "a2")
	s.roll("b")
	if got := strings.Join(s.items, ","); got != "a,c,a2,b" {
		t.Fatalf("stack model %s, want a,c,a2,b", got)
	}
	script, err := s.b.Script()
	if err != nil {
		t.Fatal(err)
	}
	if want := []byte{0x52, 0x79, 0x52, 0x7a}; string(script) != string(want) {
		t.Fatalf("emitted %x, want 2 PICK 2 ROLL", script)
	}
}
