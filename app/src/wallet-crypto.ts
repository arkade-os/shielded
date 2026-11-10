type Circomlib = Awaited<typeof import('circomlibjs')>;
type Poseidon = Awaited<ReturnType<Circomlib['buildPoseidon']>>;

let poseidon:Promise<Poseidon>|undefined;

export function loadWalletPoseidon(){
 poseidon??=import('circomlibjs').then(({buildPoseidon})=>buildPoseidon());
 return poseidon;
}

export function preloadWalletPoseidon(){
 void loadWalletPoseidon().catch(()=>{});
}
