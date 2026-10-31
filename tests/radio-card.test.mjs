import test from 'node:test';
import assert from 'node:assert/strict';
import {radioCard} from '../game/prototype/radioCard.js';
test('contextual radio hides unavailable actions and prioritizes confirmations without opening menus',()=>{
 const state={finished:false,confirmation:{},stationary:false,balloon:null,groundReady:false};
 assert.equal(radioCard(state),null);
 assert.equal(radioCard({...state,stationary:true}),null);
 assert.equal(radioCard({...state,balloon:{ready:true}}),null);
 assert.equal(radioCard({...state,stationary:true,balloon:{ready:false}}).enabled,false);
 assert.equal(radioCard({...state,stationary:true,balloon:{ready:true}}).kind,'wind');
 assert.equal(radioCard({...state,groundReady:true}).kind,'ground');
 assert.equal(radioCard({...state,stationary:true,balloon:{ready:false},groundReady:true}).kind,'ground');
 assert.equal(radioCard({...state,confirmation:{drop:true,landing:true},groundReady:true}).kind,'drop');
 assert.equal(radioCard({...state,confirmation:{landing:true}}).kind,'landing');
 assert.equal(radioCard({...state,finished:true,confirmation:{drop:true}}),null);
});
test('crew request has one-card priority only when stopped, and wind is locked before ground report',()=>{
 const state={finished:false,confirmation:{},stationary:true,balloon:{ready:true},groundReady:false,windUnlocked:false};
 assert.equal(radioCard(state),null);
 const crew={kind:'overhead',label:'上空クリアです。',enabled:true};
 assert.equal(radioCard({...state,crew,confirmation:{drop:true}}),crew);
 assert.equal(radioCard({...state,crew,stationary:false}),null);
 assert.equal(radioCard({...state,windUnlocked:true}).kind,'wind');
});


test('a held measurement keeps its button despite moving or new competing messages',()=>{
 const state={finished:false,stationary:false,confirmation:{drop:true},groundReady:true,
   crew:{kind:'overhead',label:'上空クリアです。'},pendingWind:{id:'red'}};
 assert.equal(radioCard(state).kind,'wind');
 assert.equal(radioCard({...state,stationary:true}).kind,'wind');
 assert.equal(radioCard({...state,finished:true}),null);
 assert.equal(radioCard({...state,pendingWind:null,stationary:true}).kind,'overhead');
});
