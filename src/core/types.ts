export type Tool='pen'|'highlighter'|'eraser'|'rectangle'|'ellipse'|'arrow'|'text'|'lasso'|'hand';
export type ID=string; export interface Point{x:number;y:number;p:number;t:number} export interface Bounds{x:number;y:number;w:number;h:number}
export interface Board{id:ID;name:string;created:number;updated:number;favorite:boolean;folder:string;subject:string;chapter:string;recent:number}
export interface Layer{id:ID;name:string;visible:boolean;locked:boolean;order:number}
export type SceneObject=Stroke|Shape|TextObject|ImageObject;
export interface BaseObject{id:ID;boardId:ID;layerId:ID;type:string;bounds:Bounds;rotation:number;z:number;created:number;updated:number;selected?:boolean}
export interface Stroke extends BaseObject{type:'stroke';points:Point[];color:string;width:number;highlighter:boolean}
export interface Shape extends BaseObject{type:'rect'|'ellipse'|'arrow';color:string;fill:string;width:number;from:Point;to:Point}
export interface TextObject extends BaseObject{type:'text';text:string;color:string;fontSize:number}
export interface ImageObject extends BaseObject{type:'image';mime:string;data:string}
export interface Chunk{id:string;boardId:ID;cx:number;cy:number;objects:SceneObject[];loadedAt:number;dirty:boolean}
export interface Camera{x:number;y:number;zoom:number;targetZoom:number}
export const CHUNK_SIZE=2048; export const uid=()=>crypto.randomUUID();
export const boundsOfPoints=(pts:Point[],pad=1):Bounds=>{let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of pts){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y)};return {x:minX-pad,y:minY-pad,w:Math.max(1,maxX-minX+pad*2),h:Math.max(1,maxY-minY+pad*2)}};
export const intersects=(a:Bounds,b:Bounds)=>a.x<=b.x+b.w&&a.x+a.w>=b.x&&a.y<=b.y+b.h&&a.y+a.h>=b.y;
export const chunkId=(boardId:ID,cx:number,cy:number)=>`${boardId}:${cx}:${cy}`;
export const chunksForBounds=(b:Bounds,margin=0)=>{const r=[] as {cx:number;cy:number}[];for(let cx=Math.floor((b.x-margin)/CHUNK_SIZE);cx<=Math.floor((b.x+b.w+margin)/CHUNK_SIZE);cx++)for(let cy=Math.floor((b.y-margin)/CHUNK_SIZE);cy<=Math.floor((b.y+b.h+margin)/CHUNK_SIZE);cy++)r.push({cx,cy});return r};
