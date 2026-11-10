export function nativeBuildIdentity(env:Record<string,string|undefined>,readCommit:()=>string){
 if(env.SHIELDED_NATIVE!=='1')return {commit:'',buildNumber:0,platform:''};
 let commit=env.GITHUB_SHA??'';
 if(!/^[a-f0-9]{40}$/.test(commit)){try{commit=readCommit().trim();}catch{commit='';}}
 if(!/^[a-f0-9]{40}$/.test(commit))commit='';
 const runNumber=Number(env.GITHUB_RUN_NUMBER),buildNumber=/^[1-9]\d*$/.test(env.GITHUB_RUN_NUMBER??'')&&Number.isSafeInteger(runNumber)?runNumber:0;
 const targets:Record<string,string>={'x86_64-pc-windows-msvc':'windows-x86_64','x86_64-unknown-linux-gnu':'linux-x86_64','universal-apple-darwin':'macos-universal','aarch64-linux-android':'android-arm64','aarch64-apple-ios':'ios','aarch64-apple-ios-sim':'ios','x86_64-apple-ios':'ios'};
 const candidate=env.NATIVE_PLATFORM??targets[env.TAURI_ENV_TARGET_TRIPLE??'']??'';
 const platform=['windows-x86_64','linux-x86_64','macos-universal','android-arm64','ios'].includes(candidate)?candidate:'';
 return {commit,buildNumber,platform};
}
