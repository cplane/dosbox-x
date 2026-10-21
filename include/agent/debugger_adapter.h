#ifndef DOSBOX_AGENT_DEBUGGER_ADAPTER_H
#define DOSBOX_AGENT_DEBUGGER_ADAPTER_H

#include "config.h"

#include <cstdint>
#include <string>
#include <vector>

namespace dosbox_agent {

enum class MemorySpace {
    Segmented,
    Linear,
    Physical
};

struct SegmentedMemoryAddress {
    std::uint16_t segment = 0;
    std::uint32_t offset = 0;
};

struct MemoryAddress {
    MemorySpace space = MemorySpace::Segmented;
    std::uint16_t segment = 0;
    std::uint32_t offset = 0;
};

struct MemoryAccessError {
    std::string reason;
    std::uint32_t failing_offset = 0;
};

struct RegisterSnapshot {
    std::uint32_t eax = 0;
    std::uint32_t ebx = 0;
    std::uint32_t ecx = 0;
    std::uint32_t edx = 0;
    std::uint32_t esi = 0;
    std::uint32_t edi = 0;
    std::uint32_t ebp = 0;
    std::uint32_t esp = 0;
    std::uint16_t cs = 0;
    std::uint16_t ds = 0;
    std::uint16_t es = 0;
    std::uint16_t fs = 0;
    std::uint16_t gs = 0;
    std::uint16_t ss = 0;
    std::uint32_t instruction_pointer = 0;
    std::uint32_t flags = 0;
    std::string cpu_mode;
};

struct TraceSample {
    MemoryAddress address;
    RegisterSnapshot registers;
    std::string instruction;
    std::string analysis;
};

enum class StepMode {
    Into,
    Over
};

enum class BreakpointKind {
    Execution,
    MemoryChange
};

struct NativeBreakpoint {
    std::uintptr_t handle = 0;
    BreakpointKind kind = BreakpointKind::Execution;
    MemoryAddress address;
    bool once = false;
};

// One data access the target (or DOS/BIOS emulation on its behalf) made since the last step or continue.
struct MemoryAccess {
    std::uint32_t address = 0; // linear
    std::uint8_t size = 0;
    bool write = false;
    std::uint16_t cs = 0;
    std::uint32_t instruction_pointer = 0;
};

// One instruction as the debugger's disassembler prints it.
struct DisassembledLine {
    std::uint32_t offset = 0;        // within the requested address space/segment
    std::vector<std::uint8_t> bytes; // the instruction's encoding
    std::string text;                // e.g. "mov ax,1234"
};

class DebuggerAdapter {
public:
    bool IsAvailable() const;
    bool RequireAvailable(std::string* error) const;
    bool IsShellReady() const;
    bool IsReadyForTargetStart() const;
    std::uint64_t EntryBreakpointSequence() const;
    bool Continue(std::string* error) const;
    bool Pause(std::string* error) const;
    bool StartTargetAtEntry(const std::string& command,
                            const std::vector<std::string>& arguments,
                            const std::string& workdir,
                            std::string* error) const;
    bool GetRegisters(RegisterSnapshot* registers, std::string* error) const;
    bool Step(StepMode mode, bool* continued, std::string* error) const;
    bool ReadMemory(const MemoryAddress& address,
                    std::size_t length,
                    std::vector<std::uint8_t>* data,
                    MemoryAccessError* access_error,
                    std::string* error) const;
    // Up to count instructions from address, in the CPU's current code size.
    bool Disassemble(const MemoryAddress& address,
                     std::size_t count,
                     std::vector<DisassembledLine>* lines,
                     MemoryAccessError* access_error,
                     std::string* error) const;
    bool WriteMemory(const MemoryAddress& address,
                     const std::vector<std::uint8_t>& data,
                     std::vector<std::uint8_t>* after,
                     MemoryAccessError* access_error,
                     std::string* error) const;
    bool CreateBreakpoint(BreakpointKind kind,
                          const MemoryAddress& address,
                          bool once,
                          NativeBreakpoint* breakpoint,
                          MemoryAccessError* access_error,
                          std::string* error) const;
    bool DeleteBreakpoint(const NativeBreakpoint& breakpoint, std::string* error) const;
    std::uintptr_t ConsumeLastBreakpointHandle() const;
    bool ExecuteDiagnosticCommand(const std::string& command,
                                  std::string* raw_output,
                                  std::string* error) const;
    // The accesses recorded since the last step/continue; dropped counts the ones past the log's bound.
    bool ReadMemoryAccesses(std::vector<MemoryAccess>* accesses, std::uint32_t* dropped, std::string* error) const;
    bool StartTrace(const std::string& detail, std::uint32_t instruction_count, std::string* error) const;
    bool ReadTrace(std::vector<TraceSample>* samples, bool* active, std::string* error) const;
    bool StopTrace(std::size_t* event_count, std::string* error) const;
    bool IsTraceComplete() const;
    bool TerminateTarget(std::string* error) const;
};

} // namespace dosbox_agent

#endif
