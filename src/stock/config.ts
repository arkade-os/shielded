import {MUTINY_ARK_URL,MUTINY_EMULATOR_URL,parseStockEndpoint} from './network.ts';

export interface StockInstallConfig {
 network:{name:'mutinynet';arkUrl:string;emulatorUrl:string;indexerUrl:string;dataDirectory:string};
 secrets:{bootstrapMnemonic?:string};
 allowDevelopmentSetup:boolean;
}

/** Read container settings without placing secret material in the public network config. */
export function loadStockInstallConfig(env:Record<string,string|undefined>=process.env):StockInstallConfig {
 const network=(env.SHIELDED_NETWORK??'mutinynet').trim().toLowerCase();
 if(network!=='mutinynet')throw new Error('SHIELDED_NETWORK currently supports only mutinynet.');
 const arkUrl=parseStockEndpoint((env.SHIELDED_ARK_URL??MUTINY_ARK_URL).trim(),'SHIELDED_ARK_URL');
 const emulatorUrl=parseStockEndpoint((env.SHIELDED_EMULATOR_URL??MUTINY_EMULATOR_URL).trim(),'SHIELDED_EMULATOR_URL');
 const indexerUrl=env.SHIELDED_INDEXER_URL?.trim()?parseStockEndpoint(env.SHIELDED_INDEXER_URL.trim(),'SHIELDED_INDEXER_URL'):arkUrl;
 const legacyData=env.SHIELDED_STOCK_DATA_DIR?.trim(),data=env.SHIELDED_DATA_DIR?.trim();
 if(legacyData&&data&&legacyData!==data)throw new Error('SHIELDED_DATA_DIR and SHIELDED_STOCK_DATA_DIR disagree.');
 const dataDirectory=data||legacyData||'/data';
 if(!dataDirectory.startsWith('/')&&!/^[A-Za-z]:[\\/]/.test(dataDirectory))throw new Error('SHIELDED_DATA_DIR must be an absolute container path.');
 const setupValues=[env.SHIELDED_ALLOW_DEV_SETUP,env.SHIELDED_STOCK_ALLOW_DEV_SETUP].filter(value=>value!==undefined).map(value=>value!.trim().toLowerCase());
 if(setupValues.some(value=>value!=='true'&&value!=='false')||new Set(setupValues).size>1)throw new Error('SHIELDED_ALLOW_DEV_SETUP and SHIELDED_STOCK_ALLOW_DEV_SETUP must agree and be true or false.');
 const bootstrapMnemonic=env.SHIELDED_BOOTSTRAP_MNEMONIC?.trim()||undefined;
 return {
  network:{name:'mutinynet',arkUrl,emulatorUrl,indexerUrl,dataDirectory},
  secrets:{...(bootstrapMnemonic?{bootstrapMnemonic}:{})},
  allowDevelopmentSetup:setupValues[0]==='true',
 };
}
