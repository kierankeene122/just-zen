const test=require('node:test'),assert=require('node:assert/strict');
const {sanitizeFormattedHtml}=require('./document-sanitize.cjs');
test('formatted text export keeps bare allowlisted tags and neutralises everything else',()=>{
 assert.equal(sanitizeFormattedHtml('<p onclick="x">Hi <B>there</B></p>'),'<p>Hi <B>there</B></p>');
 assert.equal(sanitizeFormattedHtml('<script>alert(1)</script><img src=x onerror=y><p>ok</p>'),'&lt;script&gt;alert(1)&lt;/script&gt;&lt;img&gt;<p>ok</p>');
 const nested=sanitizeFormattedHtml('<scr<script>ipt>x</script>');assert.equal(nested,'&lt;scr&gt;ipt&gt;x&lt;/script&gt;');assert.ok(!/<(?!\/?(?:p|br|b|strong|i|em|u|s|ul|ol|li|h[1-6]|table|tbody|tr|td|th|blockquote)>)/i.test(nested),'no raw tag other than the allowlist survives');
 assert.equal(sanitizeFormattedHtml('<p title="a>b">t</p><br/>'),'<p>b"&gt;t</p><br>');
 assert.equal(sanitizeFormattedHtml('<iframe src="file:///etc/passwd"></iframe><style>*{}</style>'),'&lt;iframe&gt;&lt;/iframe&gt;&lt;style&gt;*{}&lt;/style&gt;');
});
