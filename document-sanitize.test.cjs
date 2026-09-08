const test=require('node:test'),assert=require('node:assert/strict');
const {sanitizeFormattedHtml}=require('./document-sanitize.cjs');
test('formatted text export keeps bare allowlisted tags and neutralises everything else',()=>{
 assert.equal(sanitizeFormattedHtml('<p onclick="x">Hi <B>there</B></p>'),'<p>Hi <B>there</B></p>');
 assert.equal(sanitizeFormattedHtml('<script>alert(1)</script><img src=x onerror=y><p>ok</p>'),'&lt;script&gt;alert(1)&lt;/script&gt;&lt;img&gt;<p>ok</p>');
 assert.equal(sanitizeFormattedHtml('<scr<script>ipt>x</script>'),'&lt;scr&lt;script&gt;ipt&gt;x&lt;/script&gt;');
 assert.equal(sanitizeFormattedHtml('<p title="a>b">t</p><br/>'),'<p>b"&gt;t</p><br>');
 assert.equal(sanitizeFormattedHtml('<iframe src="file:///etc/passwd"></iframe><style>*{}</style>'),'&lt;iframe&gt;&lt;/iframe&gt;&lt;style&gt;*{}&lt;/style&gt;');
});
