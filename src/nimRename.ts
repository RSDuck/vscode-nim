/*---------------------------------------------------------
 * Copyright (C) Xored Software Inc. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import { getDirtyFile } from './nimUtils';
import { execNimSuggest, NimSuggestResult, NimSuggestType } from './nimSuggestExec';


export class NimRenameProvider implements vscode.RenameProvider {

    public provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken)
        : vscode.WorkspaceEdit | Thenable<vscode.WorkspaceEdit> {
        return new Promise((resolve, reject) => {
            vscode.workspace.saveAll(false).then(() => {
                execNimSuggest(NimSuggestType.use, document.fileName, position.line + 1, position.character, getDirtyFile(document))
                    .then(result => {
                        let resultInTheCurrentDocument: NimSuggestResult = null;
                        result.forEach(element => {
                            if(element.uri == document.uri)
                                resultInTheCurrentDocument = element;
                        });
                        
                    })
                    .catch(reason => reject(reason));
            });
        });
    }
}