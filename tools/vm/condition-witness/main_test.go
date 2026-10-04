package main

import (
	"strings"
	"testing"
)

func TestConditionClosureFinalizationRequiresEncodedEmptyWitness(t *testing.T) {
	if err := finalizeCondition(missing); err == nil || !strings.Contains(err.Error(), "failed to read condition witness: EOF") {
		t.Fatalf("missing field should fail with the observed EOF, got %v", err)
	}
	if err := finalizeCondition(empty); err != nil {
		t.Fatalf("encoded-empty field should finalize the registered compact closure: %v", err)
	}
	if err := finalizeCondition(nonEmpty); err == nil || !strings.Contains(err.Error(), "condition") {
		t.Fatalf("non-empty field should fail closed, got %v", err)
	}
	if err := finalizeCondition(duplicate); err == nil || !strings.Contains(err.Error(), "sets 2 condition witnesses") {
		t.Fatalf("duplicate fields should fail closed, got %v", err)
	}
}
