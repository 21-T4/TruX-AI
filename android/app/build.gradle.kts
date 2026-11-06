plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing comes from CI secrets (see .github/workflows/android.yml).
val keystorePath: String? = System.getenv("TRUX_KEYSTORE_PATH")

android {
    namespace = "ai.trux.assistant"
    compileSdk = 34

    defaultConfig {
        applicationId = "ai.trux.assistant"
        minSdk = 26
        targetSdk = 34
        versionCode = (System.getenv("TRUX_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("TRUX_VERSION_NAME") ?: "1.0"
        buildConfigField("String", "APP_URL", "\"" + (System.getenv("TRUX_APP_URL") ?: "https://trux-ai-workspace.trux.website") + "\"")
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("TRUX_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TRUX_KEY_ALIAS") ?: "trux"
                keyPassword = System.getenv("TRUX_KEY_PASSWORD") ?: System.getenv("TRUX_KEYSTORE_PASSWORD")
                storeType = "pkcs12"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (keystorePath != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
