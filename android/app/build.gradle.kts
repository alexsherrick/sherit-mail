import java.util.Properties

plugins { id("com.android.application") }
// Firebase is wired only once its config exists: without app/google-services.json the app builds and runs, just without push.
if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")

// The release key lives OUTSIDE the repo (~/.config/mailhub). Same key forever: Android refuses an update signed by another.
val keyProps = Properties().apply {
    val f = File(System.getProperty("user.home"), ".config/mailhub/android-keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.sheritlabs.mail"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.sheritlabs.mail"
        minSdk = 29
        targetSdk = 36
        versionCode = 16
        versionName = "1.15"
    }
    signingConfigs {
        create("release") {
            if (keyProps.isNotEmpty()) {
                storeFile = File(keyProps.getProperty("storeFile"))
                storePassword = keyProps.getProperty("storePassword")
                keyAlias = keyProps.getProperty("keyAlias")
                keyPassword = keyProps.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keyProps.isNotEmpty()) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.core:core:1.19.1")
    implementation("androidx.browser:browser:1.10.0")
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("com.google.firebase:firebase-messaging:25.1.3")
    // Firebase drags in an old androidx.fragment; a current one keeps the activity-result (permission) APIs correct.
    implementation("androidx.fragment:fragment:1.9.1")
}
