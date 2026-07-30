import org.gradle.api.tasks.compile.JavaCompile
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    kotlin("jvm") version "2.0.21"
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
}

tasks.named<KotlinCompile>("compileKotlin") {
    source(
        "../app/src/main/java/com/ayush/smsbudgetcompanion/SmsModels.kt",
        "../app/src/main/java/com/ayush/smsbudgetcompanion/SmsPayloadBuilder.kt",
        "../app/src/main/java/com/ayush/smsbudgetcompanion/TransactionSmsFilter.kt",
        "../app/src/main/java/com/ayush/smsbudgetcompanion/HmacUploadClient.kt",
    )
    compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
}

tasks.named<KotlinCompile>("compileTestKotlin") {
    source(
        "../app/src/test/java/com/ayush/smsbudgetcompanion/TransactionSmsFilterTest.kt",
        "../app/src/test/java/com/ayush/smsbudgetcompanion/HmacUploadClientTest.kt",
        "../app/src/test/java/com/ayush/smsbudgetcompanion/SmsPayloadBuilderTest.kt",
    )
    compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
}
