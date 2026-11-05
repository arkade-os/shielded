import {join} from 'node:path';
import express,{type Express} from 'express';

export function serveWeb(app:Express,web:string):void{
 app.get(['/','/wallet','/claim','/verify','/watch'],(_req,res)=>res.sendFile('index.html',{root:web}));
 app.use('/assets',express.static(join(web,'assets'),{immutable:true,maxAge:'365d'}));
 // A day, paired with updateViaCache:'all' at registration, is how often a browser asks this server for a new worker; private keeps Cloudflare from adding a day of its own.
 app.get('/sw.js',(_req,res)=>res.sendFile('sw.js',{root:web,headers:{'Cache-Control':'private, max-age=86400'}}));
 app.use(express.static(web));
}
