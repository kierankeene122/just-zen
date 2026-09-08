import {createDocumentPane} from './document-pane.js';
createDocumentPane({call:(...args)=>window.documents.call(...args)});
