import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import groovy.json.JsonSlurper

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val signingPolicy = JsonSlurper().parse(file("../../../android-signing.json")) as Map<*, *>
val updateCertificate = signingPolicy["certificateSha256"] as? String ?: error("Missing Android signing certificate")
val updatePackage = signingPolicy["packageName"] as? String ?: error("Missing Android package identity")
require(signingPolicy["schema"] == 1 && updatePackage == "io.arkade.shielded" && Regex("[a-f0-9]{64}").matches(updateCertificate))

android {
    namespace = "io.arkade.shielded.platform"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        buildConfigField("String", "SHIELDED_UPDATE_CERT_SHA256", "\"$updateCertificate\"")
        buildConfigField("String", "SHIELDED_PACKAGE_NAME", "\"$updatePackage\"")
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_11 } }

dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.7.0")
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    testImplementation("junit:junit:4.13.2")
}
