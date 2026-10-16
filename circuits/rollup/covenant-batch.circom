pragma circom 2.2.2;
// Covenant test fixture: the batch public layout, 10 pubs then the statement.
template CovenantBatch() {
    signal input x[11];
    signal square[11];
    for (var i = 0; i < 11; i++) square[i] <== x[i] * x[i];
}
component main {public [x]} = CovenantBatch();
