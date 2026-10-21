#include "config.h"

#if C_GAMELINK

#include <sys/types.h>
#include <assert.h>
#include <math.h>
#include <algorithm>
#include <cerrno>
#include <cstring>

#include "dosbox.h"
#include "dos_inc.h"
#include "logging.h"
#include "menudef.h"
#include "sdlmain.h"
#include "render.h"
#include "vga.h"
#include "mem.h"
#include "mixer.h"
#include "mapper.h"
#include "mouse.h"
#include "keyboard.h"
#include "../gamelink/scancodes_windows.h"
#include "output/output_surface.h"
#include "output/output_opengl.h"
#include <output/output_tools_xbrz.h>

using namespace std;

extern uint32_t RunningProgramHash[4];
extern bool user_cursor_locked;
extern MOUSE_EMULATION user_cursor_emulation;
extern int user_cursor_x, user_cursor_y;
extern int user_cursor_sw, user_cursor_sh;

// Bit 7 of sSharedMMapInput_R2::mouse_btn (unused by the protocol, whose
// buttons are bits 0-2): mouse_dx/dy hold an absolute position.
static const uint8_t GAMELINK_MOUSE_ABSOLUTE = 0x80;
#if !defined(C_SDL2)
#error "gamelink output requires SDL2"
#endif

void OUTPUT_GAMELINK_Select()
{
    //LOG_MSG("OUTPUT_GAMELINK: Select");
    if (!sdl.gamelink.enable) {
#ifdef WIN32
        MessageBoxA( NULL, "ERROR: Game Link output disabled.",
                                "DOSBox \"Game Link\" Error", MB_OK | MB_ICONSTOP );
#else // WIN32
#if defined(MACOSX) && !defined(__arm64__) && C_OPENGL
        LOG_MSG( "OUTPUT_GAMELINK: Not enabled via `gamelink master = true`, falling back to `output=opengl`." );
        OUTPUT_OPENGL_Select(GLBilinear);
#else // MACOSX
        LOG_MSG( "OUTPUT_GAMELINK: Not enabled via `gamelink master = true`, falling back to `output=surface`." );
        OUTPUT_SURFACE_Select();
#endif //!MACOSX
#endif
        return;
    }

    sdl.desktop.want_type = SCREEN_GAMELINK;
    render.aspectOffload = true;
    sdl.desktop.fullscreen = false;
    sdl.mouse.autoenable = false;
    sdl.gamelink.want_mouse = false;
}

void OUTPUT_GAMELINK_InputEvent()
{
    //LOG_MSG("OUTPUT_GAMELINK: InputEvent");
    //
    // Client Mouse & Keyboard

    // Commands (e.g. ":rescan") are only read when a frame goes out, and a
    // static screen renders none: push the current frame to get them read.
    if ( GameLink::MessagePending() ) OUTPUT_GAMELINK_Transfer();

    // Back-pressure: leave the client's input block unconsumed until the
    // guest has read every scancode of the previous change (plus 2 ms of
    // emulated time), so keys reach it no faster than a person could type
    // them however fast the client sends. Otherwise a slow guest either
    // overflows the controller queue (KEYBOARD_AddBuffer() then drops all
    // of it) or, with an ISR that reads port 60h twice, gets keys swapped.
    // The client waits for 'ready' to clear before publishing the next
    // change. Bounded, so a guest that never reads the keyboard doesn't
    // freeze the mouse.
    static Uint32 deferred_since = 0;
    if ( !KEYBOARD_IdleFor( 2.0 ) ) {
        const Uint32 now = SDL_GetTicks();
        if ( !deferred_since ) deferred_since = now ? now : 1;
        if ( now - deferred_since < 1000 ) return;
    }
    deferred_since = 0;

    if ( GameLink::In( &sdl.gamelink.input, &sdl.gamelink.audio ) )
    {
        //
        // -- Audio

        float vol0 = sdl.gamelink.audio.master_vol_l / 100.0f;
        float vol1 = sdl.gamelink.audio.master_vol_r / 100.0f;
        MIXER_SetMaster( vol0, vol1 );


        //
        // -- Input

        // The cursor flags below are normally refreshed from SDL motion
        // events, which never arrive here; without setting them DOSBox-X
        // snaps the DOS cursor to the absent host cursor (0,0) and never
        // accumulates mickeys.
        user_cursor_locked = true;

        if ( sdl.gamelink.input.mouse_btn & GAMELINK_MOUSE_ABSOLUTE )
        {
            // Extension: mouse_dx/dy are an absolute position, 0..1 across
            // the frame (a client drawing its own cursor, e.g. a browser).
            // The DOS cursor goes exactly there, as in seamless mouse
            // integration on a desktop, so a click lands where the client's
            // cursor is however late the frames arrive. The movement still
            // counts as mickeys for programs that read relative motion.
            static float last_x = -1.0f, last_y = -1.0f;
            const float nx = std::min( std::max( sdl.gamelink.input.mouse_dx, 0.0f ), 1.0f );
            const float ny = std::min( std::max( sdl.gamelink.input.mouse_dy, 0.0f ), 1.0f );
            const int sw = std::max( 2, (int)sdl.draw.width );
            const int sh = std::max( 2, (int)sdl.draw.height );
            const float dx = last_x < 0.0f ? 0.0f : ( nx - last_x ) * sw;
            const float dy = last_y < 0.0f ? 0.0f : ( ny - last_y ) * sh;
            const bool moved = last_x < 0.0f || nx != last_x || ny != last_y;
            last_x = nx;
            last_y = ny;

            user_cursor_sw = sw;
            user_cursor_sh = sh;
            user_cursor_x = (int)lroundf( nx * ( sw - 1 ) );
            user_cursor_y = (int)lroundf( ny * ( sh - 1 ) );
            user_cursor_emulation = MOUSE_EMULATION_NEVER; // position from user_cursor_*
            if ( moved )
                Mouse_CursorMoved( dx, dy, nx, ny, false /*emulate*/ );
        }
        else
        {
            // Relative motion, like a captured host mouse.
            user_cursor_emulation = sdl.mouse.emulation;
            Mouse_CursorMoved(
                sdl.gamelink.input.mouse_dx,
                sdl.gamelink.input.mouse_dy,
                0,
                0, true /*emulate*/ );
        }

        // Cache old and new
        const uint8_t old = sdl.gamelink.input_prev.mouse_btn;;
        const uint8_t btn = sdl.gamelink.input.mouse_btn;

        // Generate mouse events.
        for ( uint8_t i = 0; i < 3; ++i )
        {
            const uint8_t mask = 1 << i;
            if ( ( btn & mask ) && !( old & mask ) ) {
                Mouse_ButtonPressed( i ); // L
            }
            if ( !( btn & mask ) && ( old & mask ) ) {
                Mouse_ButtonReleased( i ); // L
            }
        }

        // Generate key events
        for ( uint8_t blk = 0; blk < 8; ++blk )
        {
            const uint32_t old = sdl.gamelink.input_prev.keyb_state[ blk ];
            const uint32_t key = sdl.gamelink.input.keyb_state[ blk ];
            for ( uint8_t bit = 0; bit < 32; ++bit )
            {
                const SDL_Scancode scancode = windows_scancode_table[static_cast< int >( ( blk * 32 ) + bit )];
            
                // Build event
                SDL_Event ev;
                ev.key.type = 0;
                ev.key.keysym.scancode = scancode;
            
                ev.key.keysym.mod = KMOD_NONE; // todo
                ev.key.keysym.sym = SDLK_UNKNOWN; // todo

                const uint32_t mask = 1 << bit;
                if ( ( key & mask ) && !( old & mask ) ) {
                    ev.key.type = SDL_KEYDOWN;
                    ev.key.state = SDL_PRESSED;
                }
                if ( !( key & mask ) && ( old & mask ) ) {
                    ev.key.type = SDL_KEYUP;
                    ev.key.state = SDL_RELEASED;
                }

                // Dispatch?
                if ( ev.key.type != 0 )
                {
                    MAPPER_CheckEvent( &ev );
                }
            }
        }

        // Update history state
        memcpy( &sdl.gamelink.input_prev, &sdl.gamelink.input, sizeof( GameLink::sSharedMMapInput_R2 ) );
    }
}

bool OUTPUT_GAMELINK_InitTrackingMode()
{
    //LOG_MSG("OUTPUT_GAMELINK: Game Link %s", sdl.gamelink.enable?"enabled":"disabled");
    if (!sdl.gamelink.enable) return false;

    bool trackonly_mode = sdl.desktop.want_type != SCREEN_GAMELINK;

    memset(&sdl.gamelink.input_prev, 0, sizeof(GameLink::sSharedMMapInput_R2));
    int iresult = GameLink::Init(trackonly_mode);
    if (iresult != 1) {
#ifdef WIN32
        MessageBoxA( NULL, "ERROR: Couldn't initialise Game Link inter-process communication.",
                                "DOSBox \"Game Link\" Error", MB_OK | MB_ICONSTOP );
#else // WIN32
        LOG_MSG("GAMELINK: Couldn't initialise inter-process communication.");
#endif // WIN32
        sdl.gamelink.enable = false;
        return false;
    }
    return true;
}


Bitu OUTPUT_GAMELINK_SetSize()
{
    //LOG_MSG("OUTPUT_GAMELINK: SetSize");
    Bitu bpp = 0;
    Bitu retFlags = 0;
    (void)bpp;

    if (sdl.desktop.fullscreen) GFX_ForceFullscreenExit();

    sdl.surface = nullptr;
    sdl.clip.w = sdl.draw.width;
    sdl.clip.h = sdl.draw.height;
    sdl.clip.x = 0;
    sdl.clip.y = 0;

    // FIXME: Please use sdl.draw.width and sdl.draw.height and allocate based on that.
    //        Free the buffer and reallocate on size change. Look at the OpenGL output
    //        code for a good example.
    if (!sdl.gamelink.framebuf) {
        sdl.gamelink.framebuf = malloc(SCALER_MAXWIDTH * SCALER_MAXHEIGHT * 4);   // 32 bit color frame buffer
    }
    sdl.gamelink.pitch = sdl.draw.width*4;

    sdl.desktop.type = SCREEN_GAMELINK;
    retFlags = GFX_CAN_32 | GFX_SCALING;

    LOG_MSG("GAMELINK: rendersize=%ux%u", (unsigned int)sdl.draw.width, (unsigned int)sdl.draw.height);

#if C_XBRZ
    if (sdl_xbrz.enable)
    {
        bool old_scale_on = sdl_xbrz.scale_on;
        xBRZ_SetScaleParameters(sdl.draw.width, sdl.draw.height, sdl.desktop.window.width, sdl.desktop.window.height);
        if (sdl_xbrz.scale_on != old_scale_on) {
            // when we are scaling, we ask render code not to do any aspect correction
            // when we are not scaling, render code is allowed to do aspect correction at will
            // due to this, at each scale mode change we need to schedule resize again because window size could change
            PIC_AddEvent(VGA_SetupDrawing, 50); // schedule another resize here, render has already been initialized at this point and we have just changed its option
        }
        sdl.clip.x = sdl.clip.y = 0;
        sdl.clip.w = sdl.desktop.window.width;
        sdl.clip.h = sdl.desktop.window.height;
        sdl.gamelink.pitch = sdl.clip.w*4;
    }
#endif

    if (sdl.clip.w > GameLink::sSharedMMapFrame_R1::MAX_WIDTH || sdl.clip.h > GameLink::sSharedMMapFrame_R1::MAX_HEIGHT) {
#ifdef WIN32
        MessageBoxA( NULL, "ERROR: Game Link output resolution too big (windowresolution).",
                                "DOSBox \"Game Link\" Error", MB_OK | MB_ICONSTOP );
#else // WIN32
        LOG_MSG("GAMELINK: Output resolution too big (windowresolution).");
#endif // WIN32
        sdl.gamelink.enable = false;
        return 0;
    }

    sdl.deferred_resize = false;
    sdl.must_redraw_all = true;

    sdl.window = GFX_SetSDLWindowMode(640, 200, SCREEN_GAMELINK);
    if (sdl.window == NULL)
        E_Exit("Could not set windowed video mode %ix%i: %s", (int)sdl.draw.width, (int)sdl.draw.height, SDL_GetError());

    sdl.surface = SDL_GetWindowSurface(sdl.window);

    // FIXME: find proper way to refresh the menu bar without causing infinite recursion
    static bool in_setsize = false;
    if (!in_setsize) {
        in_setsize = true;
        DOSBox_RefreshMenu();
        in_setsize = false;
    }

    return retFlags;
}

bool OUTPUT_GAMELINK_StartUpdate(uint8_t* &pixels, Bitu &pitch)
{
    //LOG_MSG("OUTPUT_GAMELINK: StartUpdate");
#if C_XBRZ
    if (sdl_xbrz.enable && sdl_xbrz.scale_on)
    {
        sdl_xbrz.renderbuf.resize(sdl.draw.width * sdl.draw.height);
        pixels = sdl_xbrz.renderbuf.empty() ? nullptr : reinterpret_cast<uint8_t*>(&sdl_xbrz.renderbuf[0]);
        pitch = sdl.draw.width * sizeof(uint32_t);
    }
    else
#endif
    {
        pixels = (uint8_t *)sdl.gamelink.framebuf;
        pitch = sdl.gamelink.pitch;
    }

    sdl.updating = true;
    return true;
}

// ---- Text screen mirror (an extension to Game Link) -------------------------
//
// In text modes the screen is also published as data -- character cells,
// cursor, palette, font, codepage -- in a shared memory block of its own,
// /DWD_GAMELINK_TEXT_R1, beside the Game Link frame. A client can then draw
// the text itself (sharp at any size, in the DOS font or any other) and read
// the screen as text, instead of decoding pixels. The block is a seqlock:
// seq is odd while it is being written; a reader copies it and retries if
// seq was odd or changed meanwhile.
#if !defined(WIN32)
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>

namespace {

enum {
    TEXT_MAX_COLS  = 132,
    TEXT_MAX_ROWS  = 60,
    TEXT_MAX_CELLS = TEXT_MAX_COLS * TEXT_MAX_ROWS,
};

enum {
    TEXT_ACTIVE         = 1 << 0, // the screen is in a text mode; the rest is valid
    TEXT_CURSOR_VISIBLE = 1 << 1,
    TEXT_BLINK          = 1 << 2, // attribute bit 7 blinks (else: bright background)
    TEXT_LINE_GRAPHICS  = 1 << 3, // 9-wide cells repeat column 8 for chars C0-DF
    TEXT_FONT           = 1 << 4, // font[] holds the VGA font
};

#pragma pack( push, 1 )
struct sGameLinkText_R1
{
    uint32_t magic;            // "DBXT"
    uint16_t version;          // 1
    uint16_t flags;            // TEXT_*
    volatile uint32_t seq;     // even: stable; odd: being written
    uint16_t cols, rows;
    uint16_t cell_w, cell_h;   // pixels per character cell (8 or 9 wide)
    uint16_t cursor_x, cursor_y;
    uint8_t  cursor_start, cursor_end; // scanlines within the cell
    uint16_t codepage;         // of the character bytes (437 when none is loaded)
    uint32_t font_seq;         // bumped whenever font[] changes
    uint8_t  errorlevel;       // v2: DOS return code of the last program that ended (IF ERRORLEVEL)
    uint8_t  reserved[3];
    uint8_t  palette[16][3];   // RGB (8 bits each) of attribute colors 0-15
    uint8_t  font[256][32];    // glyph scanlines, MSB = leftmost; cell_h of them used
    uint8_t  cells[TEXT_MAX_CELLS][2]; // character, attribute; row-major
};
#pragma pack( pop )

sGameLinkText_R1* text_block = nullptr;
bool text_unavailable = false;

bool text_open()
{
    if ( text_block ) return true;
    if ( text_unavailable ) return false;
    const int fd = shm_open( "/DWD_GAMELINK_TEXT_R1", O_CREAT | O_RDWR, 0644 );
    if ( fd < 0 || ftruncate( fd, sizeof( sGameLinkText_R1 ) ) != 0 ) {
        LOG_MSG( "GAMELINK: text mirror unavailable (errno %d)", errno );
        if ( fd >= 0 ) close( fd );
        text_unavailable = true;
        return false;
    }
    void* p = mmap( nullptr, sizeof( sGameLinkText_R1 ), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0 );
    close( fd );
    if ( p == MAP_FAILED ) {
        text_unavailable = true;
        return false;
    }
    text_block = static_cast< sGameLinkText_R1* >( p );
    memset( text_block, 0, sizeof( sGameLinkText_R1 ) );
    text_block->magic = 0x54584244; // "DBXT"
    text_block->version = 2;
    return true;
}

void text_begin( sGameLinkText_R1& t ) { t.seq = t.seq + 1; __sync_synchronize(); }
void text_end( sGameLinkText_R1& t ) { __sync_synchronize(); t.seq = t.seq + 1; }

uint8_t dac8( uint8_t v ) { return vga.dac.bits == 8 ? v : (uint8_t)( ( v << 2 ) | ( v >> 4 ) ); }

// The screen as DOS programs see it: the BIOS data area for the mode, size,
// page and cursor; the active page's cells through normal memory access.
void OUTPUT_GAMELINK_PublishText()
{
    if ( !text_open() ) return;
    sGameLinkText_R1& t = *text_block;

    const uint16_t cols = real_readw( 0x40, 0x4A );
    const uint16_t rows = (uint16_t)real_readb( 0x40, 0x84 ) + 1;
    const uint16_t cell_h = real_readw( 0x40, 0x85 );
    const bool text = vga.mode == M_TEXT && IS_EGAVGA_ARCH &&
        cols >= 1 && cols <= TEXT_MAX_COLS && rows >= 1 && rows <= TEXT_MAX_ROWS &&
        cell_h >= 1 && cell_h <= 32;
    if ( !text ) {
        if ( t.flags & TEXT_ACTIVE ) {
            text_begin( t );
            t.flags = 0;
            text_end( t );
        }
        return;
    }

    const uint8_t page = real_readb( 0x40, 0x62 );
    const uint16_t page_start = real_readw( 0x40, 0x4E );
    const uint16_t seg = real_readb( 0x40, 0x49 ) == 7 ? 0xB000 : 0xB800;
    const uint16_t cursor = real_readw( 0x40, 0x50 + ( page & 7 ) * 2 );
    // Cursor shape: the scanlines the CRTC actually draws (vga.draw.cursor),
    // not the BIOS value at 40:60, which keeps the CGA-style shape (e.g. 6-7)
    // that the VGA BIOS scales to the real cell height.
    const uint8_t cur_start = vga.draw.cursor.sline & 0x1f;
    const uint8_t cur_end = vga.draw.cursor.eline & 0x1f;

    static uint8_t font[256][32];
    bool font_changed = false;
    uint16_t flags = TEXT_ACTIVE;
    if ( IS_VGA_ARCH && vga.draw.font_tables[0] ) {
        uint8_t next[256][32] = {};
        for ( unsigned c = 0; c < 256; ++c )
            for ( unsigned l = 0; l < cell_h; ++l )
                next[c][l] = vga.draw.font_tables[0][( ( c << 5 ) + l ) * 4];
        if ( memcmp( next, font, sizeof( font ) ) != 0 ) {
            memcpy( font, next, sizeof( font ) );
            font_changed = true;
        }
        flags |= TEXT_FONT;
    }
    if ( vga.draw.cursor.enabled && cur_start <= cur_end ) flags |= TEXT_CURSOR_VISIBLE;
    if ( vga.draw.blinking ) flags |= TEXT_BLINK;
    if ( vga.attr.mode_control & 0x04 ) flags |= TEXT_LINE_GRAPHICS;

    text_begin( t );
    t.flags = flags;
    t.cols = cols;
    t.rows = rows;
    t.cell_w = vga.draw.char9dot ? 9 : 8;
    t.cell_h = cell_h;
    t.cursor_x = cursor & 0xff;
    t.cursor_y = cursor >> 8;
    t.cursor_start = cur_start;
    t.cursor_end = cur_end;
    t.codepage = dos.loaded_codepage ? dos.loaded_codepage : 437;
    t.errorlevel = dos.return_code;
    for ( unsigned i = 0; i < 16; ++i ) {
        const RGBEntry& e = vga.dac.rgb[ vga.dac.combine[i] ];
        t.palette[i][0] = dac8( e.red );
        t.palette[i][1] = dac8( e.green );
        t.palette[i][2] = dac8( e.blue );
    }
    if ( font_changed ) {
        memcpy( t.font, font, sizeof( font ) );
        t.font_seq = t.font_seq + 1;
    }
    for ( unsigned i = 0, n = (unsigned)cols * rows; i < n; ++i ) {
        t.cells[i][0] = real_readb( seg, (uint16_t)( page_start + i * 2 ) );
        t.cells[i][1] = real_readb( seg, (uint16_t)( page_start + i * 2 + 1 ) );
    }
    text_end( t );
}

} // namespace

// Console stream: every byte DOS programs write to the CON device (stdout
// and stderr of programs, the shell's prompt and the echo of what is typed)
// in order, in /DWD_GAMELINK_CON_R1. A ring buffer: write_pos counts all
// bytes ever written and the ring holds the last `size` of them, so a
// reader that keeps its own position has lost data when write_pos moved
// more than `size` past it. Fast output that scrolls off the screen between
// two frames is still complete here; what programs put on the screen
// directly (video memory, INT 10h) is not, the text mirror has that.
namespace {

enum { CON_RING = 256 * 1024 };

#pragma pack( push, 1 )
struct sGameLinkCon_R1
{
    uint32_t magic;            // "DBXC"
    uint16_t version;          // 1
    uint16_t reserved;
    uint32_t size;             // CON_RING
    uint32_t reserved2;
    volatile uint64_t write_pos; // total bytes written so far
    uint8_t  ring[CON_RING];
};
#pragma pack( pop )

sGameLinkCon_R1* con_block = nullptr;
bool con_unavailable = false;

bool con_open()
{
    if ( con_block ) return true;
    if ( con_unavailable ) return false;
    const int fd = shm_open( "/DWD_GAMELINK_CON_R1", O_CREAT | O_RDWR, 0644 );
    if ( fd < 0 || ftruncate( fd, sizeof( sGameLinkCon_R1 ) ) != 0 ) {
        LOG_MSG( "GAMELINK: console stream unavailable (errno %d)", errno );
        if ( fd >= 0 ) close( fd );
        con_unavailable = true;
        return false;
    }
    void* p = mmap( nullptr, sizeof( sGameLinkCon_R1 ), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0 );
    close( fd );
    if ( p == MAP_FAILED ) {
        con_unavailable = true;
        return false;
    }
    con_block = static_cast< sGameLinkCon_R1* >( p );
    memset( con_block, 0, sizeof( sGameLinkCon_R1 ) );
    con_block->size = CON_RING;
    con_block->version = 1;
    __sync_synchronize();
    con_block->magic = 0x43584244; // "DBXC"
    return true;
}

} // namespace
#endif // !WIN32

// Live heat: how often each 16-byte paragraph of the first megabyte was read
// and written, in /DWD_GAMELINK_HEAT_R1, counted by the agent's memory hook
// (debug build only) while the sidecar has `enabled` set — a heat map of a
// program running at full speed. Counters wrap; a reader keeps its own copy
// and takes differences. `frame` ticks once per output frame so a reader
// can tell the emulator is alive.
#if !defined(WIN32)
namespace {

enum { HEAT_BUCKETS = 65536, HEAT_SHIFT = 4 };

#pragma pack( push, 1 )
struct sGameLinkHeat_R1
{
    uint32_t magic;            // "DBXH"
    uint16_t version;          // 1
    uint16_t bucket_shift;     // HEAT_SHIFT: a bucket is 1 << shift bytes
    uint32_t buckets;          // HEAT_BUCKETS
    volatile uint32_t enabled; // set by the sidecar: count accesses
    volatile uint64_t frame;   // output frames so far
    uint16_t reads[HEAT_BUCKETS];
    uint16_t writes[HEAT_BUCKETS];
};
#pragma pack( pop )

sGameLinkHeat_R1* heat_block = nullptr;
bool heat_unavailable = false;
bool heat_was_enabled = false;

bool heat_open()
{
    if ( heat_block ) return true;
    if ( heat_unavailable ) return false;
    const int fd = shm_open( "/DWD_GAMELINK_HEAT_R1", O_CREAT | O_RDWR, 0644 );
    if ( fd < 0 || ftruncate( fd, sizeof( sGameLinkHeat_R1 ) ) != 0 ) {
        LOG_MSG( "GAMELINK: heat map unavailable (errno %d)", errno );
        if ( fd >= 0 ) close( fd );
        heat_unavailable = true;
        return false;
    }
    void* p = mmap( nullptr, sizeof( sGameLinkHeat_R1 ), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0 );
    close( fd );
    if ( p == MAP_FAILED ) {
        heat_unavailable = true;
        return false;
    }
    heat_block = static_cast< sGameLinkHeat_R1* >( p );
    memset( heat_block, 0, sizeof( sGameLinkHeat_R1 ) );
    heat_block->version = 1;
    heat_block->bucket_shift = HEAT_SHIFT;
    heat_block->buckets = HEAT_BUCKETS;
    __sync_synchronize();
    heat_block->magic = 0x48584244; // "DBXH"
    return true;
}

} // namespace
#endif // !WIN32

#if defined(C_DEBUG) && defined(C_DOSBOX_AGENT) && defined(C_HEAVY_DEBUG)
void DEBUG_AgentHeatEnable(bool on);
#endif

// Once per output frame: the sidecar's wish, and the frame counter.
void OUTPUT_GAMELINK_HeatFrame()
{
#if !defined(WIN32)
    if ( !sdl.gamelink.enable || sdl.desktop.want_type != SCREEN_GAMELINK ) return;
    if ( !heat_open() ) return;
    heat_block->frame++;
#if defined(C_DEBUG) && defined(C_DOSBOX_AGENT) && defined(C_HEAVY_DEBUG)
    const bool on = heat_block->enabled != 0;
    if ( on != heat_was_enabled ) {
        heat_was_enabled = on;
        DEBUG_AgentHeatEnable( on );
    }
#endif
#endif
}

// From the agent's memory hook, for every data access while enabled.
void OUTPUT_GAMELINK_HeatCount(uint32_t address, bool write)
{
#if !defined(WIN32)
    if ( !heat_block ) return;
    const uint32_t b = address >> HEAT_SHIFT;
    if ( b >= HEAT_BUCKETS ) return;
    if ( write ) heat_block->writes[ b ]++; else heat_block->reads[ b ]++;
#else
    (void)address; (void)write;
#endif
}

void OUTPUT_GAMELINK_ConsoleWrite(const uint8_t* data, size_t n)
{
#if !defined(WIN32)
    if ( n == 0 || !sdl.gamelink.enable || sdl.desktop.want_type != SCREEN_GAMELINK ) return;
    if ( !con_open() ) return;
    sGameLinkCon_R1& c = *con_block;
    const uint64_t pos = c.write_pos;
    for ( size_t i = 0; i < n; ++i )
        c.ring[ ( pos + i ) % CON_RING ] = data[ i ];
    __sync_synchronize();
    c.write_pos = pos + n;
#else
    (void)data; (void)n;
#endif
}

void OUTPUT_GAMELINK_Transfer()
{
    //LOG_MSG("OUTPUT_GAMELINK: Transfer");
    OUTPUT_GAMELINK_HeatFrame();
    GameLink::Out( (uint16_t)sdl.clip.w+2*sdl.clip.x, (uint16_t)sdl.clip.h+2*sdl.clip.y, render.src.ratio,
        sdl.gamelink.want_mouse,
        RunningProgram.c_str(),
        RunningProgramHash,
        (const uint8_t*)sdl.gamelink.framebuf,
        MemBase );
#if !defined(WIN32)
    if ( sdl.gamelink.enable ) OUTPUT_GAMELINK_PublishText();
#endif
}

void OUTPUT_GAMELINK_EndUpdate(const uint16_t *changedLines)
{
    //LOG_MSG("OUTPUT_GAMELINK: EndUpdate");
#if C_XBRZ
    if (sdl_xbrz.enable && sdl_xbrz.scale_on)
    {
        const uint32_t srcWidth = sdl.draw.width;
        const uint32_t srcHeight = sdl.draw.height;
        if (sdl_xbrz.renderbuf.size() == (unsigned int)srcWidth * (unsigned int)srcHeight && srcWidth > 0 && srcHeight > 0)
        {
            // please use sdl.clip to keep screen positioning consistent with the rest of the emulator
            int clipWidth = sdl.clip.w;
            int clipHeight = sdl.clip.h;
            int clipX = sdl.clip.x;
            int clipY = sdl.clip.y;

            // 1. xBRZ-scale render buffer into xbrz pixel buffer
            unsigned int xbrzWidth = 0;
            unsigned int xbrzHeight = 0;
            uint32_t* xbrzBuf;
            xbrzWidth = srcWidth * (unsigned int)sdl_xbrz.scale_factor;
            xbrzHeight = srcHeight * (unsigned int)sdl_xbrz.scale_factor;
            sdl_xbrz.pixbuf.resize(xbrzWidth * xbrzHeight);

            const uint32_t* renderBuf = &sdl_xbrz.renderbuf[0]; // help VS compiler a little + support capture by value
            xbrzBuf = &sdl_xbrz.pixbuf[0];
            xBRZ_Render(renderBuf, xbrzBuf, changedLines, (int)srcWidth, (int)srcHeight, sdl_xbrz.scale_factor);

            // 2. nearest neighbor/bilinear scale xbrz buffer into output surface clipping area
            uint32_t* clipTrg = reinterpret_cast<uint32_t*>(static_cast<char*>(sdl.gamelink.framebuf) + clipY * sdl.gamelink.pitch + (unsigned int)clipX * sizeof(uint32_t));
            xBRZ_PostScale(&xbrzBuf[0], (int)xbrzWidth, (int)xbrzHeight, (int)(xbrzWidth * sizeof(uint32_t)),
                &clipTrg[0], clipWidth, clipHeight, sdl.gamelink.pitch, 
                sdl_xbrz.postscale_bilinear, sdl_xbrz.task_granularity);

        }
    }
#endif /*C_XBRZ*/
    if (!menu.hidecycles) frames++;
    SDL_UpdateWindowSurface(sdl.window);
}

void OUTPUT_GAMELINK_Shutdown()
{
    //LOG_MSG("OUTPUT_GAMELINK: Shutdown");
    GameLink::Term();
}

#endif
