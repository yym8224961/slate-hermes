#pragma once

#include <string>
#include <vector>

namespace cache::staging {

struct Swap {
    std::string staged;
    std::string target;
    std::string backup;
    bool        had_target = false;
    bool        installed  = false;
};

bool CommitSwaps(std::vector<Swap>& swaps);

}  // namespace cache::staging
