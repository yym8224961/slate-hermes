#pragma once

#include "network/cred_store.h"

namespace setup_flow {

bool TryConnectAndSetup(cred::Credentials& credentials);

}  // namespace setup_flow
