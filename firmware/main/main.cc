#include "app/app.h"

extern "C" void app_main(void) {
    static App app;
    app.Init();
    app.Run();
}
