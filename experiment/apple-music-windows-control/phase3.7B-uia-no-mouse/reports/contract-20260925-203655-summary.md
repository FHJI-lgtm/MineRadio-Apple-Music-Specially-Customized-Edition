# contract probe round (extracted from contract-20260925-203655.jsonl)

| # | case | scenario | pattern | exists | supportsAction | invoked | succeeded | actionError | treeChanged | newControls | geomAfter | smtcChanged | smtcExpected | innerInvoke | pauseRan | mouseMoved | fgChanged | result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | E10 | N1 | item-container | false | false | false | false | Method invocation failed because [System.Collections.Specialized.OrderedDictionary] does not contain a method named 'TryGetCurrentPattern'. | false | 0 | true | false | false | false | true | false | false | **PATTERN_NOT_SUPPORTED** |
| 2 | E10 | N1 | expand-collapse | false | false | false | false |  | false | 0 | true | false | false | false | true | false | false | **PATTERN_NOT_SUPPORTED** |
| 3 | E10 | N1 | toggle | false | false | false | false |  | false | 0 | true | false | false | false | true | false | false | **PATTERN_NOT_SUPPORTED** |
| 4 | E10 | N1 | legacy-accessible | false | false | false | false |  | false | 0 | true | false | false | false | true | false | false | **PATTERN_NOT_RESOLVABLE** |
| 5 | E10 | N1 | internal-control-invoke | false | false | false | false |  | false | 0 | true | false | false | true | true | false | false | **INTERNAL_INVOKE_NO_EFFECT** |
| 6 | E10 | N2 | internal-control-invoke | false | false | false | false |  | false | 0 | true | false | false | true | true | false | false | **INTERNAL_INVOKE_NO_EFFECT** |
| 7 | E10 | N4 | internal-control-invoke | false | false | false | false |  | false | 0 | true | false | false | true | true | false | false | **INTERNAL_INVOKE_NO_EFFECT** |
| 8 | CTRL-A | N1 | internal-control-invoke | false | false | false | false |  | false | 0 | true | false | false | true | true | false | false | **INTERNAL_INVOKE_NO_EFFECT** |
| 9 | CTRL-C | N1 | internal-control-invoke | false | false | false | false |  | false | 0 | true | false | false | true | true | false | false | **INTERNAL_INVOKE_NO_EFFECT** |

detail per pattern probe:
- patternId=10019 detail=[] actionError=[Method invocation failed because [System.Collections.Specialized.OrderedDictionary] does not contain a method named 'TryGetCurrentPattern'.]
- patternId=10005 detail=[] actionError=[]
- patternId=10015 detail=[] actionError=[]
- patternId=10018 detail=[pattern-id-not-resolvable-on-this-machine] actionError=[]
- patternId=0 detail=[] actionError=[]
- patternId=0 detail=[] actionError=[]
- patternId=0 detail=[] actionError=[]
- patternId=0 detail=[] actionError=[]
- patternId=0 detail=[] actionError=[]