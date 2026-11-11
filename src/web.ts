import {join} from 'node:path';
import express,{type Express} from 'express';
import {NATIVE_RELEASE_ENDPOINT} from './native-release.ts';
import {createNativeReleasesHandler} from './native-releases.ts';

export function serveWeb(app:Express,web:string):void{
 app.get(NATIVE_RELEASE_ENDPOINT,createNativeReleasesHandler());
 app.get(['/','/download','/index.html','/wallet','/claim','/verify','/watch'],(_req,res)=>res.sendFile('index.html',{root:web,headers:{'Cache-Control':'no-cache'}}));
 app.use('/assets',express.static(join(web,'assets'),{immutable:true,maxAge:'365d'}));
 app.get('/sw.js',(_req,res)=>res.sendFile('sw.js',{root:web,headers:{'Cache-Control':'private, no-cache'}}));
 app.use(express.static(web));
}
