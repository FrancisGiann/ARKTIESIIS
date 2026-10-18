const test = require('node:test');
const assert = require('node:assert/strict');
const {createGeminiFieldExtractionService} = require('../src/services/geminiFieldExtractionService');
const fields = JSON.stringify({student_name:'QA Synthetic'});
const request = {buffer:Buffer.from('%PDF-synthetic'),mimeType:'application/pdf',documentType:'report_card'};
async function extract(envelope) {
 const service=createGeminiFieldExtractionService({apiKey:'synthetic-test-key',fetchImpl:async()=>new Response(JSON.stringify(envelope))});
 return service.extractDocument(request);
}
for(const [label,envelope,code] of [
 ['truncated',{candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:fields}]}}]},'incomplete_response'],
 ['blocked prompt',{promptFeedback:{blockReason:'SAFETY'},candidates:[{finishReason:'STOP',content:{parts:[{text:fields}]}}]},'blocked_response'],
 ['blocked candidate',{candidates:[{finishReason:'SAFETY',content:{parts:[{text:fields}]}}]},'blocked_response'],
 ['thought only',{candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:fields}]}}]},'blocked_or_empty_response'],
]) test(label+' cannot become extracted fields even with valid-looking JSON',async()=>{
 assert.deepEqual(await extract(envelope),{status:'unavailable',code,fields:null});
});
test('completed visible fields remain accepted and thought text is ignored',async()=>{
 const result=await extract({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'internal text'},{text:fields}]}}]});
 assert.equal(result.status,'extracted');assert.equal(result.fields.studentName,'QA Synthetic');
});
