pragma circom 2.2.2;
// Covenant test fixture: the batch public layout, 11 pubs then the statement.
template CovenantBatch() {
    signal input x[12];
    signal square[12];
    for (var i = 0; i < 12; i++) square[i] <== x[i] * x[i];
}
component main {public [x]} = CovenantBatch();
