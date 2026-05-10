#include "board.h"

#include <esp_adc/adc_cali.h>
#include <esp_adc/adc_cali_scheme.h>
#include <esp_adc/adc_oneshot.h>
#include <esp_log.h>
#include <esp_timer.h>

#include <sdkconfig.h>

#include "board_power.h"
#include "button.h"
#include "charge_status.h"
#include "config.h"
#include "epd_ssd1683.h"
#include "i2c_bus_lock.h"

namespace {
constexpr char     kTag[]         = "Board";
constexpr uint16_t kNavLongPressMs = 1000;
}  // namespace

Board& Board::Get() {
    static Board s;
    return s;
}

void Board::Init() {
    InitPower();
    InitI2c();
    InitChargeStatus();
    // 阶段 1：屏保取消，绿 LED 不再随充电状态闪烁。InitLed 只把 GPIO3 配 OUTPUT
    // 并熄灭，避免 strapping pin 浮空。状态指示交给 StatusBar。
    power_->InitLed();
    InitEpd();
    InitButtons();
    InitBatteryAdc();
    ESP_LOGI(kTag, "Board init done");
}

static int64_t NowMs() {
    return esp_timer_get_time() / 1000;
}

void Board::InitPower() {
    charge_ = std::make_unique<ChargeStatus>();
    // BoardPowerBsp 一次 gpio_config 把 audio rail / PA CTRL / VBAT 三个 pin 都
    // 配 OUTPUT,PA CTRL(GPIO46) 在构造完成的瞬间被驱动 LOW。后面 PowerAudioOn
    // 给 PA U5 通电时,CTRL 已稳定 LOW → 消除开机"啵"声(详见 board_power.cc)。
    // EPD_PWR(GPIO6) 由 EpdSsd1683 自管。
    power_ = std::make_unique<BoardPowerBsp>(AUDIO_PWR_PIN, AUDIO_CODEC_PA_PIN, VBAT_PWR_PIN);
    power_->VbatPowerOn();    // GPIO17=1,自锁电源
    power_->PowerAudioOn();   // GPIO42=1,AVDD_3V3 起来,I²C 上拉才有效

    // 等用户松开下键(SW1=GPIO18)。开机时硬件靠 SW1 把 Q5 栅极拉低维持电源,
    // VbatPowerOn 之后软件接管；但按键驱动一启动就会读到下键的「已按」状态而误触
    // 一次回调,所以 busy-wait 等用户先松开。
    // 2s 超时是兜底:理论上电源故障跑不到这,但加上避免硬件诡异时永久挂死。
    constexpr int kMaxWaitMs = 2000;
    int           waited     = 0;
    while (!gpio_get_level(static_cast<gpio_num_t>(VBAT_PWR_GPIO))) {
        vTaskDelay(pdMS_TO_TICKS(10));
        waited += 10;
        if (waited >= kMaxWaitMs) {
            ESP_LOGW(kTag, "Down key not released after %dms, continuing", waited);
            break;
        }
    }
}

void Board::InitI2c() {
    ScopedI2cBusLock lock("Board::InitI2c");
    ESP_ERROR_CHECK(lock.status());
    i2c_master_bus_config_t cfg      = {};
    cfg.i2c_port                     = I2C_NUM_0;
    cfg.sda_io_num                   = AUDIO_CODEC_I2C_SDA_PIN;
    cfg.scl_io_num                   = AUDIO_CODEC_I2C_SCL_PIN;
    cfg.clk_source                   = I2C_CLK_SRC_DEFAULT;
    cfg.glitch_ignore_cnt            = 7;
    cfg.intr_priority                = 0;
    cfg.trans_queue_depth            = 0;
    cfg.flags.enable_internal_pullup = 1;
    ESP_ERROR_CHECK(i2c_new_master_bus(&cfg, &i2c_bus_));
}

void Board::InitChargeStatus() {
    charge_->Init(static_cast<gpio_num_t>(CHARGE_DETECT_GPIO), static_cast<gpio_num_t>(CHARGE_FULL_GPIO), NowMs());
    charge_tick_running_.store(true);
    xTaskCreatePinnedToCore(&Board::ChargeTickTaskEntry, "charge_tick", 2 * 1024, this, 1, &charge_tick_task_, 0);
}

void Board::StopChargeTickTask() {
    if (!charge_tick_running_.exchange(false)) return;
    // 让 task 自己跑完当前周期后退出,避免硬删带锁/带 I²C 状态时 leak。
    if (charge_tick_task_) {
        // 等最多 1s,task 自己 detect 完 vTaskDelete 后我们清空句柄
        for (int i = 0; i < 50 && charge_tick_task_ != nullptr; ++i) {
            vTaskDelay(pdMS_TO_TICKS(20));
        }
    }
}

void Board::ChargeTickTaskEntry(void* arg) {
    auto*            self = static_cast<Board*>(arg);
    // 500ms 而不是 200ms:充电 IC 状态变化以秒计,kStableHighMs=400/kAltWindowMs=1500
    // 仍然能正常去抖,但任务唤醒次数减半,light-sleep 期间收益更明显。
    const TickType_t poll = pdMS_TO_TICKS(500);
    while (self->charge_tick_running_.load()) {
        self->charge_->Tick(NowMs());
        vTaskDelay(poll);
    }
    self->charge_tick_task_ = nullptr;
    vTaskDelete(nullptr);
}

void Board::InitEpd() {
    epd_ = std::make_unique<EpdSsd1683>();
    epd_->Init();
}

void Board::InitButtons() {
    // up/down 短按切车,长按 1s(留作 M3 跳转用);
    // BOOT 短按切车,长按 5s 清 NVS 凭据触发重新配网。
    // 第 5 个参数 enable_power_save=true:button 库内部会调 gpio_wakeup_enable
    // 把 GPIO 注册成 light-sleep 唤醒源,不开 light sleep 时按键无法唤醒 CPU。
    constexpr bool kPowerSave = true;
    up_btn_   = std::make_unique<Button>(static_cast<gpio_num_t>(UP_BUTTON_GPIO), false,
                                       kNavLongPressMs, 0, kPowerSave);
    down_btn_ = std::make_unique<Button>(static_cast<gpio_num_t>(DOWN_BUTTON_GPIO), false,
                                         kNavLongPressMs, 0, kPowerSave);
    // ENTER 键长按 1s = 进设置(从 frame_scene push SettingsScene)。
    // 清 NVS 重置改成 5 击触发(见 App::AttachInputs)。
    boot_btn_ = std::make_unique<Button>(static_cast<gpio_num_t>(BOOT_BUTTON_GPIO), false,
                                         kNavLongPressMs, 0, kPowerSave);
}

void Board::InitBatteryAdc() {
    // 一次性创建 ADC handle + 校准 handle。原代码用 static 局部变量+无锁,
    // 多 task 同时调 ReadBattery 会两次 adc_oneshot_new_unit 导致 abort。
    // 这里集中初始化,ReadBattery 只读不写。
    adc_oneshot_unit_init_cfg_t init_cfg = {.unit_id  = ADC_UNIT_1,
                                            .clk_src  = ADC_RTC_CLK_SRC_DEFAULT,
                                            .ulp_mode = ADC_ULP_MODE_DISABLE};
    if (adc_oneshot_new_unit(&init_cfg, &adc_handle_) != ESP_OK) {
        ESP_LOGE(kTag, "ADC oneshot_new_unit failed");
        return;
    }
    adc_oneshot_chan_cfg_t ch = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    if (adc_oneshot_config_channel(adc_handle_, ADC_CHANNEL_3, &ch) != ESP_OK) {
        ESP_LOGE(kTag, "ADC oneshot_config_channel failed");
        return;
    }
    adc_cali_curve_fitting_config_t cali = {
        .unit_id = ADC_UNIT_1, .chan = ADC_CHANNEL_3, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    if (adc_cali_create_scheme_curve_fitting(&cali, &cali_handle_) != ESP_OK) {
        ESP_LOGE(kTag, "ADC cali_create_scheme_curve_fitting failed");
        return;
    }
    adc_ready_.store(true);
}

bool Board::ReadBattery(uint16_t* voltage_mv, uint8_t* percent) {
    if (!adc_ready_.load()) return false;

    // 先看充电状态机:无电池时电压采样不可信,直接返失败。
    if (charge_ && charge_->Get().no_battery) {
        return false;
    }

    int sum = 0;
    int n   = 0;
    for (int i = 0; i < 10; ++i) {
        int raw = 0, mv = 0;
        if (adc_oneshot_read(adc_handle_, ADC_CHANNEL_3, &raw) != ESP_OK) continue;
        if (adc_cali_raw_to_voltage(cali_handle_, raw, &mv) != ESP_OK) continue;
        sum += mv * 2;  // 板上 1:2 分压,×2 还原电池电压
        n++;
    }
    if (n == 0) {
        ESP_LOGW(kTag, "ReadBattery: all ADC reads failed");
        return false;
    }
    int avg = sum / n;
    // 二阶多项式拟合:4200mV→100,3800mV→67,3300mV→0(单节锂电放电曲线)
    int p   = (-1 * avg * avg + 9016 * avg - 19189000) / 10000;
    p       = p > 100 ? 100 : (p < 0 ? 0 : p);
    if (voltage_mv) *voltage_mv = static_cast<uint16_t>(avg);
    if (percent) *percent = static_cast<uint8_t>(p);
    return true;
}
