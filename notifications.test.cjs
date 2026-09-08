const test=require('node:test');
const assert=require('node:assert/strict');
const {canNotify,unreadCount,secureOrigin}=require('./notifications.cjs');

test('notifications are restricted to saved secure app views',()=>{
 const contents={getURL:()=> 'https://mail.google.com/mail/u/0/'};const origins=new Set(['https://mail.google.com']);
 assert.equal(canNotify({contents,saved:true,origins},contents,'https://mail.google.com'),true);
 assert.equal(canNotify({contents,saved:false,origins},contents,'https://mail.google.com'),false);
 assert.equal(canNotify({contents,saved:true,origins},{getURL:contents.getURL},'https://mail.google.com'),false);
 assert.equal(canNotify({contents,saved:true,origins},contents,'http://malicious.example'),false);
 assert.equal(canNotify({contents,saved:true,origins},contents,'https://redirected.example'),false,'origins reached after landing do not gain notifications');
 assert.equal(canNotify({contents,saved:true},contents,'https://mail.google.com'),false,'no origin allowlist means no notifications');
 assert.equal(secureOrigin('http://localhost:3000'),true);
});

test('common unread title counts become bounded badges',()=>{
 assert.equal(unreadCount('(12) Inbox - Gmail'),12);
 assert.equal(unreadCount('[4] Slack'),4);
 assert.equal(unreadCount('Inbox - Gmail'),0);
 assert.equal(unreadCount('(99999) Inbox'),9999);
});

test('unread counts support Gmail and counts after the app name',()=>{
 assert.equal(unreadCount('Inbox (23) - person@example.com - Gmail'),23);
 assert.equal(unreadCount('Slack [4]'),4);
 assert.equal(unreadCount('Inbox (1,234) - Gmail'),1234);
 assert.equal(unreadCount('Teams — 2 unread messages'),2);
 assert.equal(unreadCount('Inbox - Gmail'),0);
});
