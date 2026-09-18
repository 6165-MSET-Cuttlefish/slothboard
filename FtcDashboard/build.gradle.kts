import com.android.build.gradle.internal.tasks.factory.dependsOn

plugins {
    id("com.github.node-gradle.node") version "7.1.0"
    id("dev.frozenmilk.android-library") version "12.0.0-1.2.2"
    id("dev.frozenmilk.publish") version "0.1.0"
    id("dev.frozenmilk.doc") version "0.1.0"
    id("dev.frozenmilk.build-meta-data") version "0.1.0"
    id("org.gradle.checkstyle")
}

android.namespace = "com.acmerobotics.dashboard"

// The telemetry logic resolves no android.* class, so it runs as a plain JVM test.
android.testOptions.unitTests.all { it.useJUnitPlatform() }

checkstyle {
    toolVersion = "8.18"
}

node {
    version = "18.12.1"
    download = true
    nodeProjectDir = file("${project.projectDir}/../client")
}

val yarnBuild = tasks.named("yarn_build")
val yarnInstall = tasks.named("yarn_install")

yarnBuild.dependsOn(yarnInstall)

val cleanDashAssets by tasks.registering(Delete::class) {
    delete("${android.sourceSets.getByName("main").assets.srcDirs.first()}/dash")
}

tasks.named("clean").dependsOn(cleanDashAssets)

val copyDashAssets by tasks.registering(Copy::class) {
    from("${project.projectDir}/../client/dist")
    into("${android.sourceSets.getByName("main").assets.srcDirs.first()}/dash")
}

copyDashAssets.dependsOn(cleanDashAssets)
copyDashAssets.dependsOn(yarnBuild)

android.libraryVariants.all {
    preBuildProvider.get().dependsOn(copyDashAssets)
}

repositories {
    files("../libs")
}

dairyPublishing {
    gitDir = file("..")
}

ftc {
    kotlin()
    sdk {
        compileOnly(RobotCore)
        compileOnly(Hardware)
        compileOnly(RobotServer)
        compileOnly(FtcCommon)
        compileOnly(appcompat)
    }
    dairy {
        implementation(Sloth)
    }
}

dependencies {
    api("com.acmerobotics.slothboard:core:${dairyPublishing.version}") {
        isTransitive = false
    }

    implementation("org.nanohttpd:nanohttpd-websocket:2.3.1") {
        exclude(module = "nanohttpd")
    }

    // The SDK is compileOnly for the library; the unit tests compile against Telemetry too.
    testImplementation("org.firstinspires.ftc:RobotCore:12.0.0")
    testImplementation("org.junit.jupiter:junit-jupiter:5.9.1")
    // Gradle 9 no longer puts the launcher on the test runtime classpath itself.
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.9.1")
}

meta {
    packagePath = "com.acmerobotics.dashboard"
    name = "Dashboard"
    registerField("name", "String", "\"com.acmerobotics.slothboard.Dashboard\"")
    registerField("clean", "Boolean") { "${dairyPublishing.clean}" }
    registerField("gitRef", "String") { "\"${dairyPublishing.gitRef}\"" }
    registerField("snapshot", "Boolean") { "${dairyPublishing.snapshot}" }
    registerField("version", "String") { "\"${dairyPublishing.version}\"" }
}

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "com.acmerobotics.slothboard"
            artifactId = "dashboard"

            artifact(dairyDoc.dokkaHtmlJar)
            artifact(dairyDoc.dokkaJavadocJar)

            afterEvaluate {
                from(components["release"])
            }

            pom {
                description = "Web dashboard designed for FTC"
                name = "FTC Dashboard"
                url = "https://github.com/acmerobotics/ftc-dashboard"

                licenses {
                    license {
                        name = "The MIT License"
                        url = "https://opensource.org/licenses/MIT"
                        distribution = "repo"
                    }
                }

                developers {
                    developer {
                        id = "rbrott"
                        name = "Ryan Brott"
                        email = "rcbrott@gmail.com"
                    }
                }

                scm {
                    url = "https://github.com/acmerobotics/ftc-dashboard"
                }
            }
        }
    }
}
