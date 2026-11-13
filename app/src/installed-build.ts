// Build-time constants; `typeof` keeps a build that never defined them, and the tests, from throwing.
export const installedBuild=()=>{
 const number=typeof __NATIVE_BUILD_NUMBER__==='number'?__NATIVE_BUILD_NUMBER__:0,commit=typeof __APP_COMMIT__==='string'?__APP_COMMIT__.slice(0,7):'';
 return number>0?`Build ${number}${commit?` · ${commit}`:''}`:undefined;
};
