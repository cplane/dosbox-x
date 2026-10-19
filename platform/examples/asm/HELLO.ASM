; HELLO.ASM - a tiny 8086 .COM program for the debugger (MASM 6.11):
;   ML /AT HELLO.ASM        -> HELLO.COM
; Start it in the debug panel: stops at START, step through it.
        .MODEL  TINY
        .8086
        .CODE
        ORG     100h
START:  MOV     AX, 1234h       ; something to watch in the registers
        MOV     BX, 5678h
        XOR     CX, CX
LOOP1:  INC     CX              ; count to 5
        CMP     CX, 5
        JB      LOOP1
        MOV     AH, 09h         ; DOS: print string at DS:DX
        MOV     DX, OFFSET MSG
        INT     21h
        MOV     AX, 4C00h       ; DOS: exit, code 0
        INT     21h
MSG     DB      'Hello from MASM on dos-box', 0Dh, 0Ah, '$'
        END     START
