// config.h first: C_DEBUG / C_DOSBOX_AGENT come from it in autotools builds
#include "config.h"
#if defined(C_DEBUG) && defined(C_DOSBOX_AGENT)
#include "rpc_transport.h"

#include <algorithm>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

#include <cerrno>
#include <cstring>

#ifdef WIN32
#include <windows.h>
#include <sddl.h>
#pragma comment(lib, "Advapi32.lib")
#else
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace dosbox_agent {
namespace {

class NamedPipeTransport final : public IRpcTransport {
public:
    NamedPipeTransport() : impl(new Impl()) {}
    ~NamedPipeTransport() override { Stop(); }

    const char* Name() const override { return "named_pipe"; }

    bool ValidateConfiguration(const AgentConfig& config,
                               std::string* error) const override
    {
        if (config.endpoint.compare(0, 9, "\\\\.\\pipe\\") != 0 || config.endpoint.size() == 9) {
            if (error != NULL)
                *error = "Named pipe endpoint must use \\\\.\\pipe\\<name>";
            return false;
        }
        return true;
    }

    bool Start(const AgentConfig& config,
               RequestHandler handler,
               std::string* error) override
    {
        if (!ValidateConfiguration(config, error) || !handler)
            return false;

#ifndef WIN32
        if (error != NULL)
            *error = "Windows named pipes are unavailable on this platform";
        return false;
#else
        std::unique_lock<std::mutex> lock(impl->mutex);
        if (impl->listener.joinable()) {
            if (error != NULL)
                *error = "Named pipe transport is already running";
            return false;
        }

        impl->config = config;
        impl->handler = handler;
        impl->stopping = false;
        impl->ready = false;
        impl->start_succeeded = false;
        impl->start_error.clear();
        impl->listener = std::thread(&NamedPipeTransport::Run, this);
        impl->ready_condition.wait(lock, [this]() { return impl->ready; });
        if (impl->start_succeeded)
            return true;

        const std::string start_error = impl->start_error;
        lock.unlock();
        impl->listener.join();
        if (error != NULL)
            *error = start_error;
        return false;
#endif
    }

    void Stop() override
    {
#ifdef WIN32
        std::thread listener;
        std::vector<std::thread> client_workers;
        {
            std::lock_guard<std::mutex> lock(impl->mutex);
            if (!impl->listener.joinable())
                return;
            impl->stopping = true;
            for (std::vector<HANDLE>::const_iterator it = impl->active_pipes.begin();
                 it != impl->active_pipes.end(); ++it)
                CancelIoEx(*it, NULL);
            listener.swap(impl->listener);
        }
        listener.join();
        {
            std::lock_guard<std::mutex> lock(impl->mutex);
            client_workers.swap(impl->client_workers);
        }
        for (std::vector<std::thread>::iterator it = client_workers.begin();
             it != client_workers.end(); ++it)
            if (it->joinable())
                it->join();
#endif
    }

private:
    class Impl {
    public:
        std::mutex mutex;
        std::condition_variable ready_condition;
        AgentConfig config;
        RequestHandler handler;
        std::thread listener;
        bool stopping = false;
        bool ready = false;
        bool start_succeeded = false;
        std::string start_error;
#ifdef WIN32
        HANDLE active_pipe = INVALID_HANDLE_VALUE;
        std::vector<HANDLE> active_pipes;
        std::vector<std::thread> client_workers;
#endif
    };

    std::unique_ptr<Impl> impl;

#ifdef WIN32
    static bool WriteAll(const HANDLE pipe, const std::string& message)
    {
        std::size_t offset = 0;
        while (offset < message.size()) {
            const DWORD remaining = static_cast<DWORD>((std::min)(message.size() - offset,
                                                                    static_cast<std::size_t>(0xffffffffu)));
            DWORD written = 0;
            if (!WriteFile(pipe, message.data() + offset, remaining, &written, NULL) || written == 0)
                return false;
            offset += written;
        }
        return true;
    }

    HANDLE CreatePipe(std::string* error)
    {
        PSECURITY_DESCRIPTOR descriptor = NULL;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorA("D:P(A;;GA;;;OW)",
                                                                    SDDL_REVISION_1,
                                                                    &descriptor,
                                                                    NULL)) {
            *error = "Unable to create named pipe security descriptor";
            return INVALID_HANDLE_VALUE;
        }

        SECURITY_ATTRIBUTES attributes;
        attributes.nLength = sizeof(attributes);
        attributes.lpSecurityDescriptor = descriptor;
        attributes.bInheritHandle = FALSE;
        const DWORD buffer_size = static_cast<DWORD>((std::min)(impl->config.max_message_bytes,
                                                                 static_cast<std::size_t>(0xffffffffu)));
        HANDLE pipe = CreateNamedPipeA(impl->config.endpoint.c_str(),
                                       PIPE_ACCESS_DUPLEX,
                                       PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                                       PIPE_UNLIMITED_INSTANCES,
                                       buffer_size,
                                       buffer_size,
                                       0,
                                       &attributes);
        LocalFree(descriptor);
        if (pipe == INVALID_HANDLE_VALUE)
            *error = "Unable to create named pipe endpoint";
        return pipe;
    }

    void RemoveActivePipe(const HANDLE pipe)
    {
        std::lock_guard<std::mutex> lock(impl->mutex);
        for (std::vector<HANDLE>::iterator it = impl->active_pipes.begin();
             it != impl->active_pipes.end(); ++it) {
            if (*it == pipe) {
                impl->active_pipes.erase(it);
                break;
            }
        }
    }

    bool ServeClient(const HANDLE pipe)
    {
        std::string pending;
        char buffer[4096];
        for (;;) {
            DWORD read = 0;
            if (!ReadFile(pipe, buffer, sizeof(buffer), &read, NULL) || read == 0)
                return false;
            pending.append(buffer, read);

            for (;;) {
                const std::string::size_type line_end = pending.find('\n');
                if (line_end == std::string::npos) {
                    if (pending.size() > impl->config.max_message_bytes) {
                        const std::string response = impl->handler(std::string(impl->config.max_message_bytes + 1, 'x')) + "\n";
                        WriteAll(pipe, response);
                        return false;
                    }
                    break;
                }

                std::string request = pending.substr(0, line_end);
                pending.erase(0, line_end + 1);
                if (!request.empty() && request[request.size() - 1] == '\r')
                    request.erase(request.size() - 1);
                if (request.size() > impl->config.max_message_bytes) {
                    const std::string response = impl->handler(std::string(impl->config.max_message_bytes + 1, 'x')) + "\n";
                    WriteAll(pipe, response);
                    return false;
                }
                if (!WriteAll(pipe, impl->handler(request) + "\n"))
                    return false;
            }

            std::lock_guard<std::mutex> lock(impl->mutex);
            if (impl->stopping)
                return false;
        }
    }

    void ServeClientThread(const HANDLE pipe)
    {
        ServeClient(pipe);
        CloseHandle(pipe);
        RemoveActivePipe(pipe);
    }

    void Run()
    {
        bool first_pipe = true;
        for (;;) {
            std::string error;
            const HANDLE pipe = CreatePipe(&error);
            if (pipe == INVALID_HANDLE_VALUE) {
                std::lock_guard<std::mutex> lock(impl->mutex);
                if (first_pipe) {
                    impl->start_error = error;
                    impl->ready = true;
                    impl->ready_condition.notify_all();
                }
                return;
            }

            {
                std::lock_guard<std::mutex> lock(impl->mutex);
                impl->active_pipe = pipe;
                impl->active_pipes.push_back(pipe);
                if (first_pipe) {
                    impl->start_succeeded = true;
                    impl->ready = true;
                    impl->ready_condition.notify_all();
                    first_pipe = false;
                }
                if (impl->stopping) {
                    CloseHandle(pipe);
                    impl->active_pipe = INVALID_HANDLE_VALUE;
                    impl->active_pipes.pop_back();
                    return;
                }
            }

            const BOOL connected = ConnectNamedPipe(pipe, NULL);
            const DWORD connect_error = connected ? ERROR_SUCCESS : GetLastError();
            if (connected || connect_error == ERROR_PIPE_CONNECTED) {
                bool stopping = false;
                {
                    std::lock_guard<std::mutex> lock(impl->mutex);
                    stopping = impl->stopping;
                    if (!stopping)
                        impl->client_workers.push_back(std::thread(&NamedPipeTransport::ServeClientThread, this, pipe));
                }
                if (stopping) {
                    CloseHandle(pipe);
                    RemoveActivePipe(pipe);
                    return;
                }
            } else {
                CloseHandle(pipe);
                RemoveActivePipe(pipe);
            }

            std::lock_guard<std::mutex> lock(impl->mutex);
            impl->active_pipe = INVALID_HANDLE_VALUE;
            if (impl->stopping)
                return;
        }
    }
#endif
};

class UnixSocketTransport final : public IRpcTransport {
public:
    const char* Name() const override { return "unix_socket"; }

    bool ValidateConfiguration(const AgentConfig& config,
                               std::string* error) const override
    {
        if (config.endpoint.empty() || config.endpoint[0] != '/') {
            if (error != NULL)
                *error = "Unix socket endpoint must be an absolute path";
            return false;
        }
        return true;
    }

#ifdef WIN32
    bool Start(const AgentConfig&,
               RequestHandler,
               std::string* error) override
    {
        if (error != NULL)
            *error = "Unix socket transport is unavailable on this platform";
        return false;
    }

    void Stop() override {}
#else
    // A stream Unix domain socket with the named pipe's framing: UTF-8 JSON
    // Lines, one request per line, one response per line, each client
    // served by its own thread (so a blocking execution.wait on one
    // connection doesn't hold up another). The socket file is created
    // 0600 and removed on Stop().
    UnixSocketTransport() : impl(new Impl()) {}
    ~UnixSocketTransport() override { Stop(); }

    bool Start(const AgentConfig& config,
               RequestHandler handler,
               std::string* error) override
    {
        if (!ValidateConfiguration(config, error) || !handler)
            return false;
        std::lock_guard<std::mutex> lock(impl->mutex);
        if (impl->listen_fd >= 0) {
            if (error != NULL)
                *error = "Unix socket transport is already running";
            return false;
        }
        sockaddr_un address;
        if (config.endpoint.size() >= sizeof(address.sun_path)) {
            if (error != NULL)
                *error = "Unix socket endpoint path is too long";
            return false;
        }
        const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) {
            if (error != NULL)
                *error = "Unable to create the Unix socket";
            return false;
        }
        memset(&address, 0, sizeof(address));
        address.sun_family = AF_UNIX;
        strncpy(address.sun_path, config.endpoint.c_str(), sizeof(address.sun_path) - 1);
        unlink(config.endpoint.c_str()); // a stale socket from an earlier run
        const mode_t old_umask = umask(0077);
        const int bound = bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address));
        umask(old_umask);
        if (bound != 0 || listen(fd, 8) != 0) {
            if (error != NULL)
                *error = "Unable to listen on the Unix socket " + config.endpoint;
            close(fd);
            return false;
        }
        impl->config = config;
        impl->handler = handler;
        impl->stopping = false;
        impl->listen_fd = fd;
        impl->listener = std::thread(&UnixSocketTransport::Run, this);
        return true;
    }

    void Stop() override
    {
        std::thread listener;
        std::vector<std::thread> workers;
        std::string endpoint;
        {
            std::lock_guard<std::mutex> lock(impl->mutex);
            if (impl->listen_fd < 0)
                return;
            impl->stopping = true;
            shutdown(impl->listen_fd, SHUT_RDWR);
            close(impl->listen_fd);
            impl->listen_fd = -1;
            for (std::vector<int>::const_iterator it = impl->clients.begin(); it != impl->clients.end(); ++it)
                shutdown(*it, SHUT_RDWR);
            listener.swap(impl->listener);
            endpoint = impl->config.endpoint;
        }
        if (listener.joinable())
            listener.join();
        {
            std::lock_guard<std::mutex> lock(impl->mutex);
            workers.swap(impl->workers);
        }
        for (std::vector<std::thread>::iterator it = workers.begin(); it != workers.end(); ++it)
            if (it->joinable())
                it->join();
        unlink(endpoint.c_str());
    }

private:
    class Impl {
    public:
        std::mutex mutex;
        AgentConfig config;
        RequestHandler handler;
        std::thread listener;
        std::vector<std::thread> workers;
        std::vector<int> clients;
        int listen_fd = -1;
        bool stopping = false;
    };
    std::unique_ptr<Impl> impl;

    static bool WriteAll(const int fd, const std::string& message)
    {
        std::size_t offset = 0;
        while (offset < message.size()) {
            const ssize_t written = send(fd, message.data() + offset, message.size() - offset, MSG_NOSIGNAL);
            if (written <= 0)
                return false;
            offset += static_cast<std::size_t>(written);
        }
        return true;
    }

    void Run()
    {
        for (;;) {
            int listen_fd;
            {
                std::lock_guard<std::mutex> lock(impl->mutex);
                if (impl->stopping)
                    return;
                listen_fd = impl->listen_fd;
            }
            const int client = accept(listen_fd, NULL, NULL);
            if (client < 0) {
                if (errno == EINTR)
                    continue;
                return; // closed by Stop()
            }
            std::lock_guard<std::mutex> lock(impl->mutex);
            if (impl->stopping) {
                close(client);
                return;
            }
            impl->clients.push_back(client);
            impl->workers.push_back(std::thread(&UnixSocketTransport::ServeClientThread, this, client));
        }
    }

    void ServeClientThread(const int client)
    {
        ServeClient(client);
        close(client);
        std::lock_guard<std::mutex> lock(impl->mutex);
        for (std::vector<int>::iterator it = impl->clients.begin(); it != impl->clients.end(); ++it) {
            if (*it == client) {
                impl->clients.erase(it);
                break;
            }
        }
    }

    bool ServeClient(const int client)
    {
        std::string pending;
        char buffer[4096];
        for (;;) {
            const ssize_t read = recv(client, buffer, sizeof(buffer), 0);
            if (read < 0 && errno == EINTR)
                continue;
            if (read <= 0)
                return false;
            pending.append(buffer, static_cast<std::size_t>(read));
            for (;;) {
                const std::string::size_type line_end = pending.find('\n');
                if (line_end == std::string::npos) {
                    if (pending.size() > impl->config.max_message_bytes) {
                        WriteAll(client, impl->handler(std::string(impl->config.max_message_bytes + 1, 'x')) + "\n");
                        return false;
                    }
                    break;
                }
                std::string request = pending.substr(0, line_end);
                pending.erase(0, line_end + 1);
                if (!request.empty() && request[request.size() - 1] == '\r')
                    request.erase(request.size() - 1);
                if (request.size() > impl->config.max_message_bytes) {
                    WriteAll(client, impl->handler(std::string(impl->config.max_message_bytes + 1, 'x')) + "\n");
                    return false;
                }
                if (!WriteAll(client, impl->handler(request) + "\n"))
                    return false;
            }
            std::lock_guard<std::mutex> lock(impl->mutex);
            if (impl->stopping)
                return false;
        }
    }
#endif
};

} // namespace

std::unique_ptr<IRpcTransport> AGENT_CreateLocalTransport(const AgentTransport transport)
{
    switch (transport) {
    case AgentTransport::NamedPipe:
        return std::unique_ptr<IRpcTransport>(new NamedPipeTransport());
    case AgentTransport::UnixSocket:
        return std::unique_ptr<IRpcTransport>(new UnixSocketTransport());
    }
    return std::unique_ptr<IRpcTransport>();
}

} // namespace dosbox_agent
#endif // defined(C_DEBUG) && defined(C_DOSBOX_AGENT)
