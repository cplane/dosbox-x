// Precompiled header force-included (-include) into every C++ file of the
// DOSBox-X build by compile.sh (PCH=1). Standard headers only: nothing
// here can change what a DOSBox-X or bundled-library source means, and
// it lives in platform/ so the emulator sources stay untouched. (No
// <iostream>: it would add a static initializer to every object.)
#include <algorithm>
#include <functional>
#include <list>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
