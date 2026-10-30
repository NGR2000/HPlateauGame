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
